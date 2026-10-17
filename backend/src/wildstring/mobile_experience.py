"""Authenticated recommendation and playback handoff routes shared by all clients."""

from typing import Annotated

from fastapi import APIRouter, Depends, Response

from wildstring.library.repository import LibraryRepository
from wildstring.playback_state import PlaybackState, get_state, put_state
from wildstring.recommendations import Discover, Feedback, Preferences, Recommendations


def experience_router(repository, auth, providers):
    def private_response(response: Response):
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["Vary"] = "Cookie"

    router = APIRouter(
        prefix="/api/v1", dependencies=[Depends(auth.require_session), Depends(private_response)]
    )
    recommendations = Recommendations(repository, providers)

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
    def refresh(repository: current):
        return recommendations.daily(repository, refresh=True)

    @router.post("/recommendations/feedback", dependencies=mutation)
    def feedback(body: Feedback, repository: current):
        return recommendations.feedback(repository, body)

    @router.post("/ai/discover", dependencies=mutation)
    def discover(body: Discover, repository: current):
        return recommendations.discover(repository, body)

    return router
