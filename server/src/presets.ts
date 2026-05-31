// App presets encode the correct headers / WebSocket / timeout / upload behaviour
// for popular self-hosted apps, so the "no Google needed" promise holds. Curated
// from the common homelab stack (Jellyfin, Immich, Portainer, Uptime Kuma, …).
//
// Rules of thumb:
//  - Apps with a live/realtime UI set `websockets: true` (the generated ws block
//    also raises proxy_read_timeout to 3600s — so streaming/long-poll apps just
//    set websockets and must NOT also add a proxy_read_timeout directive, which
//    would be a duplicate and fail `nginx -t`).
//  - Upload-heavy apps set `client_max_body_size`.
//  - extraDirectives are appended verbatim into the host's location block.

export interface Preset {
  id: string;
  label: string;
  emoji: string;
  category: string;
  websockets: boolean;
  http2: boolean;
  /** Extra nginx directives baked into the location block. */
  extraDirectives: string[];
  notes: string;
}

/** Category display order in the wizard picker. */
export const PRESET_CATEGORIES = [
  "Media",
  "Photos & Files",
  "Home & IoT",
  "Network & Admin",
  "Monitoring",
  "Development",
  "Communication",
  "AI",
  "Security",
  "Other",
] as const;

export const PRESETS: Record<string, Preset> = {
  // ---------------- Media ----------------
  plex: { id: "plex", label: "Plex", emoji: "🎬", category: "Media", websockets: true, http2: true, extraDirectives: ["proxy_buffering off;"], notes: "WebSocket on, buffering off for smooth streaming." },
  jellyfin: { id: "jellyfin", label: "Jellyfin", emoji: "🍿", category: "Media", websockets: true, http2: true, extraDirectives: ["proxy_buffering off;"], notes: "WebSocket on for live playback; buffering off for streaming." },
  emby: { id: "emby", label: "Emby", emoji: "📺", category: "Media", websockets: true, http2: true, extraDirectives: ["proxy_buffering off;"], notes: "WebSocket on; buffering off for streaming." },
  jellyseerr: { id: "jellyseerr", label: "Jellyseerr / Overseerr", emoji: "🎟️", category: "Media", websockets: false, http2: true, extraDirectives: [], notes: "Standard HTTP — media request management." },
  audiobookshelf: { id: "audiobookshelf", label: "Audiobookshelf", emoji: "🎧", category: "Media", websockets: true, http2: true, extraDirectives: ["client_max_body_size 2G;"], notes: "WebSocket on for progress sync; large uploads." },
  navidrome: { id: "navidrome", label: "Navidrome", emoji: "🎵", category: "Media", websockets: false, http2: true, extraDirectives: [], notes: "Music streaming — standard HTTP." },
  romm: { id: "romm", label: "RomM", emoji: "🎮", category: "Media", websockets: true, http2: true, extraDirectives: ["client_max_body_size 4G;"], notes: "WebSocket on; large uploads for ROMs." },

  // ---------------- Photos & Files ----------------
  nextcloud: { id: "nextcloud", label: "Nextcloud", emoji: "☁️", category: "Photos & Files", websockets: false, http2: true, extraDirectives: ["client_max_body_size 10G;"], notes: "Large upload limits for files and sync." },
  immich: { id: "immich", label: "Immich", emoji: "📷", category: "Photos & Files", websockets: true, http2: true, extraDirectives: ["client_max_body_size 50G;"], notes: "WebSocket on; large uploads for photo/video sync." },
  photoprism: { id: "photoprism", label: "PhotoPrism", emoji: "🖼️", category: "Photos & Files", websockets: true, http2: true, extraDirectives: ["client_max_body_size 2G;"], notes: "WebSocket on; large photo uploads." },
  paperless: { id: "paperless", label: "Paperless-ngx", emoji: "📄", category: "Photos & Files", websockets: true, http2: true, extraDirectives: ["client_max_body_size 100M;"], notes: "WebSocket on for live updates; document uploads." },
  seafile: { id: "seafile", label: "Seafile", emoji: "📁", category: "Photos & Files", websockets: false, http2: true, extraDirectives: ["client_max_body_size 10G;"], notes: "Large upload limits for file sync." },
  filebrowser: { id: "filebrowser", label: "File Browser", emoji: "🗂️", category: "Photos & Files", websockets: false, http2: true, extraDirectives: ["client_max_body_size 10G;"], notes: "Large upload limits for the web file manager." },

  // ---------------- Home & IoT ----------------
  homeassistant: { id: "homeassistant", label: "Home Assistant", emoji: "🏠", category: "Home & IoT", websockets: true, http2: true, extraDirectives: [], notes: "WebSocket on. In Home Assistant set http.use_x_forwarded_for + trusted_proxies (the NginUX container IP)." },
  nodered: { id: "nodered", label: "Node-RED", emoji: "🔴", category: "Home & IoT", websockets: true, http2: true, extraDirectives: [], notes: "WebSocket on for the live flow editor." },
  frigate: { id: "frigate", label: "Frigate NVR", emoji: "🎥", category: "Home & IoT", websockets: true, http2: true, extraDirectives: ["client_max_body_size 100M;"], notes: "WebSocket on for live video/events." },
  octoprint: { id: "octoprint", label: "OctoPrint", emoji: "🖨️", category: "Home & IoT", websockets: true, http2: true, extraDirectives: ["client_max_body_size 1G;"], notes: "WebSocket on; large gcode uploads." },

  // ---------------- Network & Admin ----------------
  portainer: { id: "portainer", label: "Portainer", emoji: "📦", category: "Network & Admin", websockets: true, http2: true, extraDirectives: [], notes: "WebSocket on for console/exec." },
  proxmox: { id: "proxmox", label: "Proxmox", emoji: "🖥️", category: "Network & Admin", websockets: true, http2: true, extraDirectives: [], notes: "WebSocket on for the noVNC console (backend is https — set the target scheme to https)." },
  pihole: { id: "pihole", label: "Pi-hole", emoji: "🕳️", category: "Network & Admin", websockets: false, http2: true, extraDirectives: [], notes: "Admin UI — usually served under /admin." },
  adguard: { id: "adguard", label: "AdGuard Home", emoji: "🛡️", category: "Network & Admin", websockets: true, http2: true, extraDirectives: [], notes: "WebSocket on for the live query log." },

  // ---------------- Monitoring ----------------
  grafana: { id: "grafana", label: "Grafana", emoji: "📊", category: "Monitoring", websockets: true, http2: true, extraDirectives: [], notes: "WebSocket on for live panels; sub-path support." },
  uptimekuma: { id: "uptimekuma", label: "Uptime Kuma", emoji: "📈", category: "Monitoring", websockets: true, http2: true, extraDirectives: [], notes: "WebSocket on (required) for the live dashboard." },

  // ---------------- Development ----------------
  gitea: { id: "gitea", label: "Gitea / Forgejo", emoji: "🍵", category: "Development", websockets: false, http2: true, extraDirectives: ["client_max_body_size 512M;"], notes: "Larger body limit for git pushes and LFS." },
  codeserver: { id: "codeserver", label: "code-server (VS Code)", emoji: "💻", category: "Development", websockets: true, http2: true, extraDirectives: [], notes: "WebSocket on (required) for the editor." },
  n8n: { id: "n8n", label: "n8n", emoji: "🧩", category: "Development", websockets: true, http2: true, extraDirectives: ["client_max_body_size 100M;"], notes: "WebSocket on for the editor; larger body for payloads." },

  // ---------------- Communication ----------------
  mattermost: { id: "mattermost", label: "Mattermost / Rocket.Chat", emoji: "💬", category: "Communication", websockets: true, http2: true, extraDirectives: ["client_max_body_size 500M;"], notes: "WebSocket on for realtime chat; larger body for file uploads." },

  // ---------------- AI ----------------
  openwebui: { id: "openwebui", label: "Open WebUI / Ollama", emoji: "🤖", category: "AI", websockets: true, http2: true, extraDirectives: ["client_max_body_size 1G;"], notes: "WebSocket on (also gives the long timeout streaming responses need); large uploads." },
  stablediffusion: { id: "stablediffusion", label: "Stable Diffusion", emoji: "🎨", category: "AI", websockets: true, http2: true, extraDirectives: ["client_max_body_size 1G;"], notes: "WebSocket on (long timeout for generation); large uploads." },

  // ---------------- Security ----------------
  vaultwarden: { id: "vaultwarden", label: "Vaultwarden", emoji: "🔐", category: "Security", websockets: true, http2: true, extraDirectives: ["client_max_body_size 128M;"], notes: "WebSocket on for the notifications hub; attachment uploads." },
  authentik: { id: "authentik", label: "Authentik", emoji: "🔑", category: "Security", websockets: true, http2: true, extraDirectives: [], notes: "WebSocket on for the admin/flow UI." },

  // ---------------- Other ----------------
  bookstack: { id: "bookstack", label: "BookStack", emoji: "📚", category: "Other", websockets: false, http2: true, extraDirectives: ["client_max_body_size 1G;"], notes: "Larger body limit for image/attachment uploads." },
  wikijs: { id: "wikijs", label: "Wiki.js", emoji: "📖", category: "Other", websockets: true, http2: true, extraDirectives: ["client_max_body_size 500M;"], notes: "WebSocket on; larger body for asset uploads." },
  custom: { id: "custom", label: "Custom / Generic", emoji: "⚙️", category: "Other", websockets: false, http2: true, extraDirectives: [], notes: "Sensible defaults + a WebSocket toggle you can flip later." },
};

export function getPreset(id: string): Preset {
  return PRESETS[id] ?? PRESETS.custom;
}
