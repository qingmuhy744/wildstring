package com.wildstring.app.data

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

data class PodcastBrowserState(
    val owner: String? = null,
    val podcasts: List<PodcastSummary> = emptyList(),
    val listLoaded: Boolean = false,
    val listLoading: Boolean = false,
    val details: Map<String, PodcastDetail> = emptyMap(),
    val loadedDetails: Set<String> = emptySet(),
    val loadingDetails: Set<String> = emptySet(),
    val message: String? = null,
)

/** Browsing data survives player navigation, while requests remain bound to one login. */
class PodcastBrowser(
    private val scope: CoroutineScope,
    private val currentOwner: () -> String?,
    private val fetchList: suspend () -> List<PodcastSummary>,
    private val cachedDetail: suspend (String) -> PodcastDetail?,
    private val fetchDetail: suspend (String) -> PodcastDetail,
    private val refreshDetail: suspend (String) -> PodcastDetail,
    private val refreshAll: suspend () -> Boolean,
) {
    private val mutable = MutableStateFlow(PodcastBrowserState())
    val state = mutable.asStateFlow()
    private var generation = 0L
    private var requestId = 0L
    private var listJob: Job? = null
    private val detailJobs = mutableMapOf<String, Job>()
    private val detailRequests = mutableMapOf<String, Long>()

    fun reset() {
        generation++
        listJob?.cancel(); listJob = null
        detailJobs.values.forEach { it.cancel() }; detailJobs.clear(); detailRequests.clear()
        mutable.value = PodcastBrowserState(owner = currentOwner())
    }

    private fun owner(): String? {
        if (mutable.value.owner != currentOwner()) reset()
        return mutable.value.owner
    }

    private fun valid(owner: String, epoch: Long) =
        owner == currentOwner() && owner == mutable.value.owner && epoch == generation

    fun ensureList() = loadList(force = false)
    fun reloadList(synchronize: Boolean = false) = loadList(force = true, synchronize = synchronize)

    private fun loadList(force: Boolean, synchronize: Boolean = false) {
        val owner = owner() ?: return
        if (mutable.value.listLoading || (!force && mutable.value.listLoaded)) return
        val epoch = generation
        mutable.update { it.copy(listLoaded = true, listLoading = true) }
        listJob = scope.launch {
            try {
                if (synchronize && !refreshAll()) error("服务端暂时无法更新订阅，请稍后下拉重试。")
                val podcasts = fetchList()
                if (valid(owner, epoch)) mutable.update { it.copy(podcasts = podcasts,
                    loadedDetails = if (force) it.loadingDetails else it.loadedDetails) }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                if (valid(owner, epoch)) mutable.update { it.copy(message = "获取播客订阅失败：${friendlyError(e)}") }
            } finally {
                if (valid(owner, epoch)) mutable.update { it.copy(listLoading = false) }
            }
        }
    }

    fun ensureDetail(id: String) = loadDetail(id, force = false)
    fun refresh(id: String, synchronize: Boolean = true) = loadDetail(id, force = true, synchronize = synchronize)

    private fun loadDetail(id: String, force: Boolean, synchronize: Boolean = false) {
        val owner = owner() ?: return
        if (id in mutable.value.loadingDetails || (!force && id in mutable.value.loadedDetails)) return
        val epoch = generation
        val request = ++requestId
        detailRequests[id] = request
        fun active() = valid(owner, epoch) && detailRequests[id] == request
        mutable.update { it.copy(loadedDetails = it.loadedDetails + id, loadingDetails = it.loadingDetails + id) }
        detailJobs[id] = scope.launch {
            try {
                if (!force && id !in mutable.value.details) {
                    val cached = cachedDetail(id)
                    if (cached != null && active()) mutable.update { it.copy(details = it.details + (id to cached)) }
                }
                val detail = if (synchronize) refreshDetail(id) else fetchDetail(id)
                if (active()) putDetail(detail)
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                if (active()) mutable.update { it.copy(message = "加载单集列表失败：${friendlyError(e)}") }
            } finally {
                if (active()) {
                    mutable.update { it.copy(loadingDetails = it.loadingDetails - id) }
                    detailJobs.remove(id)
                }
            }
        }
    }

    private fun putDetail(detail: PodcastDetail) {
        mutable.update { value -> value.copy(
            details = value.details + (detail.podcast.id to detail),
            podcasts = if (value.podcasts.any { it.id == detail.podcast.id })
                value.podcasts.map { if (it.id == detail.podcast.id) detail.podcast else it }
                else value.podcasts + detail.podcast,
        ) }
    }

    fun remember(detail: PodcastDetail) {
        owner() ?: return
        val id = detail.podcast.id
        detailRequests.remove(id); detailJobs.remove(id)?.cancel()
        putDetail(detail)
        mutable.update { it.copy(loadedDetails = it.loadedDetails + id, loadingDetails = it.loadingDetails - id) }
    }

    fun remove(id: String) {
        owner() ?: return
        detailRequests.remove(id); detailJobs.remove(id)?.cancel()
        mutable.update { it.copy(podcasts = it.podcasts.filterNot { p -> p.id == id },
            details = it.details - id, loadedDetails = it.loadedDetails - id, loadingDetails = it.loadingDetails - id) }
    }

    fun clearMessage() { mutable.update { it.copy(message = null) } }

    fun followed(id: String, value: Boolean) {
        mutable.update { state -> state.copy(podcasts = state.podcasts.map { if (it.id == id) it.copy(followed = value) else it },
            details = state.details.mapValues { (key, detail) -> if (key == id) detail.copy(podcast = detail.podcast.copy(followed = value)) else detail }) }
    }
}
