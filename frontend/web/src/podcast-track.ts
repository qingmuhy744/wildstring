import type { Track } from './api';

export interface PodcastEpisodeTrackSource {
  id: string;
  title: string;
  description: string;
  duration_seconds: number;
  pub_date: string;
  episode_number: number | null;
  season_number: number | null;
  created_at: string;
  position_seconds: number;
  completed: boolean;
}

export interface PodcastTrackSource {
  id: string;
  title: string;
  author: string;
  cover_url: string;
}

export function podcastEpisodeToTrack(
  episode: PodcastEpisodeTrackSource,
  podcast: PodcastTrackSource,
): Track {
  return {
    id: `podcast_ep_${episode.id}`,
    podcast_id: podcast.id,
    podcast_position_seconds: episode.completed ? 0 : episode.position_seconds,
    podcast_completed: episode.completed,
    album_id: '',
    title: episode.title,
    artists: [podcast.author || podcast.title],
    album_artists: [podcast.author || podcast.title],
    artist_credit: podcast.author || podcast.title,
    album_artist_credit: podcast.author || podcast.title,
    composers: [],
    lyricists: [],
    arrangers: [],
    vocalists: [],
    genres: ['Podcast'],
    tags: [],
    track_total: null,
    disc_total: null,
    release_date: episode.pub_date || null,
    original_date: null,
    external_ids: {},
    description: episode.description || '',
    cover_url: podcast.cover_url || undefined,
    track_number: episode.episode_number,
    disc_number: episode.season_number,
    album: podcast.title,
    duration_ms: episode.duration_seconds * 1000,
    has_cover: !!podcast.cover_url,
    sample_rate: 44100,
    format: 'mp3',
    status: 'available',
    loved: false,
    play_count: 0,
    listened_ms: 0,
    last_played_at: null,
    added_at: episode.created_at || new Date().toISOString(),
  };
}
