/**
 * Community playlists offered in Settings (free, publicly maintained lists). None of them is run
 * by this project: what each channel carries, whether it is up, whether it is geo-blocked and
 * whether the browser can decode it varies by the hour; the player says so per channel.
 *
 * Checked 2026-10-28: iptv-org (11,300 channels in the full list; the country and category lists
 * are subsets of it; adult channels are not in these lists) and Free-TV (about 2,000). The
 * matthuisman (i.mjh.nz) Pluto TV / Samsung TV Plus / Plex lists answer 404 now, so those
 * services are reached through iptv-org's lists instead (which carry their channels). The
 * epgshare01 guides exist for some countries (UK, IT, DE, FR, ES, MX, IN checked); the US one is gone.
 */
import type { LiveTvPreset } from '../../shared/types';

const IPTV_ORG = 'https://iptv-org.github.io/iptv';
const EPGSHARE = 'https://epgshare01.online/epgshare01';

export const LIVETV_PRESETS: LiveTvPreset[] = [
  { id: 'iptv-org-all', source: 'IPTV-org', name: 'IPTV-org – all channels', description: 'Every publicly available channel the iptv-org project lists, grouped by category. A very long list.', url: `${IPTV_ORG}/index.m3u`, approxChannels: 11300 },
  { id: 'iptv-org-us', source: 'IPTV-org', name: 'IPTV-org – United States', description: 'US channels: news, local stations, and the free ad-supported channels of Pluto TV, Samsung TV Plus, Plex and others.', url: `${IPTV_ORG}/countries/us.m3u`, approxChannels: 1400 },
  { id: 'iptv-org-ca', source: 'IPTV-org', name: 'IPTV-org – Canada', description: 'Canadian channels.', url: `${IPTV_ORG}/countries/ca.m3u` },
  { id: 'iptv-org-uk', source: 'IPTV-org', name: 'IPTV-org – United Kingdom', description: 'UK channels, with a programme guide.', url: `${IPTV_ORG}/countries/uk.m3u`, epgUrl: `${EPGSHARE}/epg_ripper_UK1.xml.gz` },
  { id: 'iptv-org-it', source: 'IPTV-org', name: 'IPTV-org – Italy', description: 'Italian channels, with a programme guide.', url: `${IPTV_ORG}/countries/it.m3u`, epgUrl: `${EPGSHARE}/epg_ripper_IT1.xml.gz` },
  { id: 'iptv-org-de', source: 'IPTV-org', name: 'IPTV-org – Germany', description: 'German channels, with a programme guide.', url: `${IPTV_ORG}/countries/de.m3u`, epgUrl: `${EPGSHARE}/epg_ripper_DE1.xml.gz` },
  { id: 'iptv-org-fr', source: 'IPTV-org', name: 'IPTV-org – France', description: 'French channels, with a programme guide.', url: `${IPTV_ORG}/countries/fr.m3u`, epgUrl: `${EPGSHARE}/epg_ripper_FR1.xml.gz` },
  { id: 'iptv-org-es', source: 'IPTV-org', name: 'IPTV-org – Spain', description: 'Spanish channels, with a programme guide.', url: `${IPTV_ORG}/countries/es.m3u`, epgUrl: `${EPGSHARE}/epg_ripper_ES1.xml.gz` },
  { id: 'iptv-org-mx', source: 'IPTV-org', name: 'IPTV-org – Mexico', description: 'Mexican channels, with a programme guide.', url: `${IPTV_ORG}/countries/mx.m3u`, epgUrl: `${EPGSHARE}/epg_ripper_MX1.xml.gz` },
  { id: 'iptv-org-in', source: 'IPTV-org', name: 'IPTV-org – India', description: 'Indian channels, with a programme guide.', url: `${IPTV_ORG}/countries/in.m3u`, epgUrl: `${EPGSHARE}/epg_ripper_IN1.xml.gz` },
  { id: 'iptv-org-news', source: 'IPTV-org', name: 'IPTV-org – News', description: 'News channels from everywhere (CNN, BBC, Al Jazeera, France 24, NHK World, DW…).', url: `${IPTV_ORG}/categories/news.m3u`, approxChannels: 960 },
  { id: 'iptv-org-sports', source: 'IPTV-org', name: 'IPTV-org – Sports', description: 'Sports channels; many are geo-blocked outside their country.', url: `${IPTV_ORG}/categories/sports.m3u`, approxChannels: 430 },
  { id: 'iptv-org-movies', source: 'IPTV-org', name: 'IPTV-org – Movies', description: 'Movie channels (many of them free ad-supported ones).', url: `${IPTV_ORG}/categories/movies.m3u`, approxChannels: 650 },
  { id: 'iptv-org-kids', source: 'IPTV-org', name: 'IPTV-org – Kids', description: 'Children’s channels.', url: `${IPTV_ORG}/categories/kids.m3u`, approxChannels: 320 },
  { id: 'iptv-org-music', source: 'IPTV-org', name: 'IPTV-org – Music', description: 'Music channels.', url: `${IPTV_ORG}/categories/music.m3u`, approxChannels: 730 },
  { id: 'iptv-org-documentary', source: 'IPTV-org', name: 'IPTV-org – Documentary', description: 'Documentary channels.', url: `${IPTV_ORG}/categories/documentary.m3u`, approxChannels: 220 },
  { id: 'iptv-org-entertainment', source: 'IPTV-org', name: 'IPTV-org – Entertainment', description: 'Entertainment channels.', url: `${IPTV_ORG}/categories/entertainment.m3u`, approxChannels: 830 },
  { id: 'free-tv', source: 'Free-TV', name: 'Free-TV – worldwide', description: 'The Free-TV/IPTV project’s curated list of legal, free channels, grouped by country.', url: 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8', approxChannels: 2000 },
];

export const presetById = (id: string): LiveTvPreset | undefined => LIVETV_PRESETS.find((p) => p.id === id);
