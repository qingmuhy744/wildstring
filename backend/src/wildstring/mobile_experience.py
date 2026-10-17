"""Authenticated recommendation and playback handoff routes shared by all clients."""

from typing import Annotated

from fastapi import APIRouter, Body, Depends, Query, Response

from wildstring.library.repository import LibraryRepository
from wildstring.playback_state import PlaybackState, get_state, put_state
from wildstring.recommendation_rankings import Metric, Period, Scope, rankings
from wildstring.recommendations import (
    Discover,
    ExternalFeedback,
    Feedback,
    GenerationOptions,
    Preferences,
    Recommendations,
)


def experience_router(repository, auth, providers, platform=None):
    def private_response(response: Response):
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["Vary"] = "Cookie"

    router = APIRouter(
        prefix="/api/v1", dependencies=[Depends(auth.require_session), Depends(private_response)]
    )
    recommendations = Recommendations(repository, providers, platform)

    def scoped(user: Annotated[dict, Depends(auth.require_session)]):
        return repository.for_user(user["id"])

    current = Annotated[LibraryRepository, Depends(scoped)]
    mutation = [Depends(auth.require_client)]

    @router.get("/playback/state")
    def playback_get(repository: current):
        return get_state(repository)

    @router.put("/playback/state", dependencies=mutation)
    def playback_put(body: PlaybackState, repository: current):
        return put_state(repository, body)

    @router.get("/recommendations/preferences")
    def preferences_get(repository: current):
        return recommendations.preferences(repository)

    @router.put("/recommendations/preferences", dependencies=mutation)
    def preferences_put(body: Preferences, repository: current):
        return recommendations.save_preferences(repository, body)

    @router.get("/recommendations/daily")
    def daily(repository: current):
        return recommendations.daily(repository)

    @router.post("/recommendations/daily/refresh", dependencies=mutation)
    def refresh(repository: current, body: Annotated[GenerationOptions | None, Body()] = None):
        return recommendations.daily(repository, refresh=True, body=body)

    @router.post("/recommendations/feedback", dependencies=mutation)
    def feedback(body: Feedback, repository: current):
        return recommendations.feedback(repository, body)

    @router.get("/recommendations/rankings")
    def ranking(
        repository: current,
        scope: Scope = "personal",
        period: Period = "30d",
        metric: Metric = "plays",
        limit: int = Query(20, ge=1, le=100),
        offset: int = Query(0, ge=0, le=1000000),
    ):
        return rankings(repository, scope, period, metric, limit, offset)

    @router.get("/recommendations/external")
    def external(repository: current):
        return recommendations.external(repository)

    @router.post("/recommendations/external/refresh", dependencies=mutation)
    def external_refresh(
        repository: current, body: Annotated[GenerationOptions | None, Body()] = None
    ):
        return recommendations.external(repository, refresh=True, body=body)

    @router.post("/recommendations/external/feedback", dependencies=mutation)
    def external_feedback(body: ExternalFeedback, repository: current):
        return recommendations.external_feedback(repository, body)

    @router.post("/ai/discover", dependencies=mutation)
    def discover(body: Discover, repository: current):
        return recommendations.discover(repository, body)

    return router
