// App presets encode the correct headers / WebSocket / timeout / upload behaviour
// for popular self-hosted apps, so the "no Google needed" promise holds. Curated
// from the common homelab stack (awesome-selfhosted, 2025 homelab roundups).
//
// Rules of thumb:
//  - `defaultPort` is the app's usual internal port (prefilled on the wizard).
//  - `forwardScheme` is set only for appliances whose backend is https.
//  - Apps with a live/realtime UI set `websockets: true` (the generated ws block
//    also raises proxy_read_timeout to 3600s — so streaming/long-poll apps just
//    set websockets and must NOT also add a proxy_read_timeout directive, which
//    would be a duplicate and fail `nginx -t`).
//  - Upload-heavy apps set `client_max_body_size` (use 0 for "no limit").
//  - `desc` is a plain-language "what this app is" (shown in the wizard picker);
//    `notes` explains the proxy config the preset applies.

export interface Preset {
  id: string;
  label: string;
  emoji: string;
  category: string;
  /** Plain-language one-liner: what the app is (shown under the name in the picker). */
  desc: string;
  defaultPort: number;
  forwardScheme?: "http" | "https";
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
  "Downloads",
  "Home & IoT",
  "Dashboards",
  "Network & Admin",
  "Monitoring",
  "Development",
  "Productivity & Office",
  "Communication",
  "AI",
  "Security",
  "Finance",
  "Bookmarks",
  "Other",
] as const;

const ws = true;

export const PRESETS: Record<string, Preset> = {
  // ---------------- Media ----------------
  plex: { id: "plex", label: "Plex", emoji: "🎬", category: "Media", desc: "Media server for movies, TV & music", defaultPort: 32400, websockets: ws, http2: true, extraDirectives: ["proxy_buffering off;"], notes: "WebSocket on, buffering off for smooth streaming." },
  jellyfin: { id: "jellyfin", label: "Jellyfin", emoji: "🍿", category: "Media", desc: "Free, open-source media server", defaultPort: 8096, websockets: ws, http2: true, extraDirectives: ["proxy_buffering off;"], notes: "WebSocket on for live playback; buffering off for streaming." },
  emby: { id: "emby", label: "Emby", emoji: "📺", category: "Media", desc: "Personal media server", defaultPort: 8096, websockets: ws, http2: true, extraDirectives: ["proxy_buffering off;"], notes: "WebSocket on; buffering off for streaming." },
  jellyseerr: { id: "jellyseerr", label: "Jellyseerr / Overseerr", emoji: "🎟️", category: "Media", desc: "Request movies & shows for your library", defaultPort: 5055, websockets: false, http2: true, extraDirectives: [], notes: "Standard HTTP — media request management." },
  servarr: { id: "servarr", label: "Sonarr / Radarr / Lidarr", emoji: "🗂️", category: "Media", desc: "Automate your TV, movie & music collection", defaultPort: 8989, websockets: false, http2: true, extraDirectives: [], notes: "The *arr apps (Sonarr 8989, Radarr 7878, Lidarr 8686, Prowlarr 9696). Set a base URL in each app to share a domain." },
  audiobookshelf: { id: "audiobookshelf", label: "Audiobookshelf", emoji: "🎧", category: "Media", desc: "Audiobook & podcast server", defaultPort: 13378, websockets: ws, http2: true, extraDirectives: ["client_max_body_size 2G;"], notes: "WebSocket on for progress sync; large uploads." },
  navidrome: { id: "navidrome", label: "Navidrome", emoji: "🎵", category: "Media", desc: "Personal music streaming server", defaultPort: 4533, websockets: false, http2: true, extraDirectives: [], notes: "Music streaming — standard HTTP." },
  calibreweb: { id: "calibreweb", label: "Calibre-Web", emoji: "📕", category: "Media", desc: "Browse & read your ebook library", defaultPort: 8083, websockets: false, http2: true, extraDirectives: ["client_max_body_size 500M;"], notes: "Larger uploads for ebooks." },
  romm: { id: "romm", label: "RomM", emoji: "🎮", category: "Media", desc: "Retro game ROM library & player", defaultPort: 8080, websockets: ws, http2: true, extraDirectives: ["client_max_body_size 4G;"], notes: "WebSocket on; large uploads for ROMs." },

  // ---------------- Photos & Files ----------------
  nextcloud: { id: "nextcloud", label: "Nextcloud", emoji: "☁️", category: "Photos & Files", desc: "Self-hosted files, photos & calendar", defaultPort: 80, websockets: false, http2: true, extraDirectives: ["client_max_body_size 10G;"], notes: "Large upload limits for files and sync." },
  immich: { id: "immich", label: "Immich", emoji: "📷", category: "Photos & Files", desc: "Photo & video backup (Google Photos alt)", defaultPort: 2283, websockets: ws, http2: true, extraDirectives: ["client_max_body_size 50G;"], notes: "WebSocket on; large uploads for photo/video sync." },
  photoprism: { id: "photoprism", label: "PhotoPrism", emoji: "🖼️", category: "Photos & Files", desc: "AI-powered photo library", defaultPort: 2342, websockets: ws, http2: true, extraDirectives: ["client_max_body_size 2G;"], notes: "WebSocket on; large photo uploads." },
  paperless: { id: "paperless", label: "Paperless-ngx", emoji: "📄", category: "Photos & Files", desc: "Scan & organize your documents", defaultPort: 8000, websockets: ws, http2: true, extraDirectives: ["client_max_body_size 100M;"], notes: "WebSocket on for live updates; document uploads." },
  seafile: { id: "seafile", label: "Seafile", emoji: "📁", category: "Photos & Files", desc: "File sync & share", defaultPort: 8000, websockets: false, http2: true, extraDirectives: ["client_max_body_size 10G;"], notes: "Large upload limits for file sync." },
  filebrowser: { id: "filebrowser", label: "File Browser", emoji: "🗄️", category: "Photos & Files", desc: "Web-based file manager", defaultPort: 80, websockets: false, http2: true, extraDirectives: ["client_max_body_size 10G;"], notes: "Large upload limits for the web file manager." },
  syncthing: { id: "syncthing", label: "Syncthing", emoji: "🔄", category: "Photos & Files", desc: "Continuous file sync between devices", defaultPort: 8384, websockets: false, http2: true, extraDirectives: [], notes: "Web UI for the sync engine — standard HTTP." },

  // ---------------- Downloads ----------------
  qbittorrent: { id: "qbittorrent", label: "qBittorrent", emoji: "🧲", category: "Downloads", desc: "BitTorrent client with a web UI", defaultPort: 8080, websockets: false, http2: true, extraDirectives: [], notes: "Web UI — standard HTTP." },
  transmission: { id: "transmission", label: "Transmission", emoji: "🔻", category: "Downloads", desc: "Lightweight BitTorrent client", defaultPort: 9091, websockets: false, http2: true, extraDirectives: [], notes: "Web UI — standard HTTP." },
  sabnzbd: { id: "sabnzbd", label: "SABnzbd", emoji: "📥", category: "Downloads", desc: "Usenet (NZB) downloader", defaultPort: 8080, websockets: false, http2: true, extraDirectives: [], notes: "Usenet downloader web UI — standard HTTP." },

  // ---------------- Home & IoT ----------------
  homeassistant: { id: "homeassistant", label: "Home Assistant", emoji: "🏠", category: "Home & IoT", desc: "Home & smart-device automation hub", defaultPort: 8123, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on. In Home Assistant set http.use_x_forwarded_for + trusted_proxies (the NginUX container IP)." },
  nodered: { id: "nodered", label: "Node-RED", emoji: "🔴", category: "Home & IoT", desc: "Visual automation flow editor", defaultPort: 1880, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on for the live flow editor." },
  frigate: { id: "frigate", label: "Frigate NVR", emoji: "🎥", category: "Home & IoT", desc: "AI camera recorder with object detection", defaultPort: 5000, websockets: ws, http2: true, extraDirectives: ["client_max_body_size 100M;"], notes: "WebSocket on for live video/events." },
  octoprint: { id: "octoprint", label: "OctoPrint", emoji: "🖨️", category: "Home & IoT", desc: "Control & monitor your 3D printer", defaultPort: 5000, websockets: ws, http2: true, extraDirectives: ["client_max_body_size 1G;"], notes: "WebSocket on; large gcode uploads." },
  zigbee2mqtt: { id: "zigbee2mqtt", label: "Zigbee2MQTT", emoji: "🐝", category: "Home & IoT", desc: "Bridge Zigbee devices to MQTT", defaultPort: 8080, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on for the live frontend." },
  esphome: { id: "esphome", label: "ESPHome", emoji: "📟", category: "Home & IoT", desc: "Firmware & dashboard for ESP devices", defaultPort: 6052, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on for the dashboard + log streaming." },
  homebridge: { id: "homebridge", label: "Homebridge", emoji: "🌉", category: "Home & IoT", desc: "Bring non-HomeKit devices to Apple Home", defaultPort: 8581, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on for the live UI/logs." },

  // ---------------- Dashboards ----------------
  homepage: { id: "homepage", label: "Homepage", emoji: "🧭", category: "Dashboards", desc: "Customizable homelab start page", defaultPort: 3000, websockets: false, http2: true, extraDirectives: [], notes: "Static homelab dashboard — standard HTTP." },
  homarr: { id: "homarr", label: "Homarr", emoji: "🧰", category: "Dashboards", desc: "Dashboard for your self-hosted apps", defaultPort: 7575, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on for live widgets." },
  dashy: { id: "dashy", label: "Dashy", emoji: "📋", category: "Dashboards", desc: "Configurable app dashboard", defaultPort: 4000, websockets: false, http2: true, extraDirectives: [], notes: "Configurable dashboard — standard HTTP." },

  // ---------------- Network & Admin ----------------
  portainer: { id: "portainer", label: "Portainer", emoji: "📦", category: "Network & Admin", desc: "Docker & container management UI", defaultPort: 9000, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on for console/exec." },
  proxmox: { id: "proxmox", label: "Proxmox", emoji: "🖥️", category: "Network & Admin", desc: "Virtualization & VM/LXC management", defaultPort: 8006, forwardScheme: "https", websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on for the noVNC console; backend is https (already set for you)." },
  pihole: { id: "pihole", label: "Pi-hole", emoji: "🕳️", category: "Network & Admin", desc: "Network-wide ad blocker (DNS)", defaultPort: 80, websockets: false, http2: true, extraDirectives: [], notes: "Admin UI — usually served under /admin." },
  adguard: { id: "adguard", label: "AdGuard Home", emoji: "🛡️", category: "Network & Admin", desc: "Network-wide ad & tracker blocker", defaultPort: 3000, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on for the live query log (port 80 after initial setup)." },
  npm: { id: "npm", label: "Nginx Proxy Manager", emoji: "🧱", category: "Network & Admin", desc: "Reverse proxy with a management UI", defaultPort: 81, websockets: false, http2: true, extraDirectives: ["client_max_body_size 1G;"], notes: "Admin UI; larger body for cert/backup uploads." },
  traefik: { id: "traefik", label: "Traefik", emoji: "🚦", category: "Network & Admin", desc: "Cloud-native reverse proxy & dashboard", defaultPort: 8080, websockets: false, http2: true, extraDirectives: [], notes: "Dashboard / API — standard HTTP." },
  wgeasy: { id: "wgeasy", label: "WG-Easy (WireGuard)", emoji: "🔌", category: "Network & Admin", desc: "WireGuard VPN with a web UI", defaultPort: 51821, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on for the live client list." },
  unifi: { id: "unifi", label: "UniFi Network", emoji: "📡", category: "Network & Admin", desc: "UniFi network controller", defaultPort: 8443, forwardScheme: "https", websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on for live stats; backend is https (already set for you)." },

  // ---------------- Monitoring ----------------
  grafana: { id: "grafana", label: "Grafana", emoji: "📊", category: "Monitoring", desc: "Metrics dashboards & visualization", defaultPort: 3000, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on for live panels; sub-path support." },
  uptimekuma: { id: "uptimekuma", label: "Uptime Kuma", emoji: "📈", category: "Monitoring", desc: "Uptime & status-page monitoring", defaultPort: 3001, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on (required) for the live dashboard." },
  netdata: { id: "netdata", label: "Netdata", emoji: "🩺", category: "Monitoring", desc: "Real-time system metrics", defaultPort: 19999, websockets: false, http2: true, extraDirectives: [], notes: "Real-time metrics dashboard — standard HTTP." },
  glances: { id: "glances", label: "Glances", emoji: "👁️", category: "Monitoring", desc: "At-a-glance system resource monitor", defaultPort: 61208, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on for live system stats." },

  // ---------------- Development ----------------
  gitea: { id: "gitea", label: "Gitea / Forgejo", emoji: "🍵", category: "Development", desc: "Lightweight self-hosted Git", defaultPort: 3000, websockets: false, http2: true, extraDirectives: ["client_max_body_size 512M;"], notes: "Larger body limit for git pushes and LFS." },
  gitlab: { id: "gitlab", label: "GitLab", emoji: "🦊", category: "Development", desc: "Git, CI/CD & DevOps platform", defaultPort: 80, websockets: false, http2: true, extraDirectives: ["client_max_body_size 1G;"], notes: "Large body for git pushes, LFS and uploads." },
  codeserver: { id: "codeserver", label: "code-server (VS Code)", emoji: "💻", category: "Development", desc: "VS Code in your browser", defaultPort: 8080, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on (required) for the editor." },
  n8n: { id: "n8n", label: "n8n", emoji: "🧩", category: "Development", desc: "Workflow automation (Zapier alternative)", defaultPort: 5678, websockets: ws, http2: true, extraDirectives: ["client_max_body_size 100M;"], notes: "WebSocket on for the editor; larger body for payloads." },
  minio: { id: "minio", label: "MinIO", emoji: "🪣", category: "Development", desc: "S3-compatible object storage", defaultPort: 9001, websockets: ws, http2: true, extraDirectives: ["client_max_body_size 0;"], notes: "WebSocket on for the console; no upload size limit (S3-compatible storage)." },

  // ---------------- Productivity & Office ----------------
  onlyoffice: { id: "onlyoffice", label: "OnlyOffice / Collabora", emoji: "📝", category: "Productivity & Office", desc: "Online document co-editing", defaultPort: 80, websockets: ws, http2: true, extraDirectives: ["client_max_body_size 500M;"], notes: "WebSocket on for co-editing; larger document uploads." },
  trilium: { id: "trilium", label: "Trilium Notes", emoji: "🌲", category: "Productivity & Office", desc: "Hierarchical note-taking", defaultPort: 8080, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on for note sync." },
  memos: { id: "memos", label: "Memos", emoji: "📓", category: "Productivity & Office", desc: "Lightweight notes & memos", defaultPort: 5230, websockets: false, http2: true, extraDirectives: [], notes: "Lightweight notes — standard HTTP." },
  vikunja: { id: "vikunja", label: "Vikunja", emoji: "☑️", category: "Productivity & Office", desc: "To-do & project management", defaultPort: 3456, websockets: false, http2: true, extraDirectives: [], notes: "To-do / project management — standard HTTP." },
  mealie: { id: "mealie", label: "Mealie", emoji: "🍽️", category: "Productivity & Office", desc: "Recipe manager & meal planner", defaultPort: 9000, websockets: false, http2: true, extraDirectives: ["client_max_body_size 200M;"], notes: "Recipe manager; larger body for imports/images." },

  // ---------------- Communication ----------------
  mattermost: { id: "mattermost", label: "Mattermost / Rocket.Chat", emoji: "💬", category: "Communication", desc: "Team chat (Slack alternative)", defaultPort: 8065, websockets: ws, http2: true, extraDirectives: ["client_max_body_size 500M;"], notes: "WebSocket on for realtime chat; larger body for file uploads." },
  matrix: { id: "matrix", label: "Matrix / Synapse", emoji: "🔲", category: "Communication", desc: "Decentralized chat homeserver", defaultPort: 8008, websockets: false, http2: true, extraDirectives: ["client_max_body_size 100M;"], notes: "Larger body for media uploads (homeserver)." },
  ntfy: { id: "ntfy", label: "ntfy", emoji: "🔔", category: "Communication", desc: "Push notifications to your devices", defaultPort: 80, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on for the subscribe stream." },
  gotify: { id: "gotify", label: "Gotify", emoji: "📲", category: "Communication", desc: "Self-hosted push notifications", defaultPort: 80, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on for the push stream." },

  // ---------------- AI ----------------
  openwebui: { id: "openwebui", label: "Open WebUI / Ollama", emoji: "🤖", category: "AI", desc: "Chat UI for local LLMs (Ollama)", defaultPort: 8080, websockets: ws, http2: true, extraDirectives: ["client_max_body_size 1G;"], notes: "WebSocket on (also gives the long timeout streaming responses need); large uploads." },
  comfyui: { id: "comfyui", label: "ComfyUI", emoji: "🧪", category: "AI", desc: "Node-based Stable Diffusion UI", defaultPort: 8188, websockets: ws, http2: true, extraDirectives: ["client_max_body_size 1G;"], notes: "WebSocket on for the live queue; large uploads." },
  stablediffusion: { id: "stablediffusion", label: "Stable Diffusion", emoji: "🎨", category: "AI", desc: "AI image generation", defaultPort: 7860, websockets: ws, http2: true, extraDirectives: ["client_max_body_size 1G;"], notes: "WebSocket on (long timeout for generation); large uploads." },

  // ---------------- Security ----------------
  vaultwarden: { id: "vaultwarden", label: "Vaultwarden", emoji: "🔐", category: "Security", desc: "Bitwarden-compatible password manager", defaultPort: 80, websockets: ws, http2: true, extraDirectives: ["client_max_body_size 128M;"], notes: "WebSocket on for the notifications hub; attachment uploads." },
  authentik: { id: "authentik", label: "Authentik", emoji: "🔑", category: "Security", desc: "Identity provider & single sign-on", defaultPort: 9000, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on for the admin/flow UI." },
  authelia: { id: "authelia", label: "Authelia", emoji: "🛂", category: "Security", desc: "Authentication & 2FA portal", defaultPort: 9091, websockets: false, http2: true, extraDirectives: [], notes: "Authentication portal — standard HTTP." },
  keycloak: { id: "keycloak", label: "Keycloak", emoji: "🔓", category: "Security", desc: "Identity & access management", defaultPort: 8080, websockets: false, http2: true, extraDirectives: [], notes: "Identity provider — standard HTTP." },

  // ---------------- Finance ----------------
  firefly: { id: "firefly", label: "Firefly III", emoji: "💰", category: "Finance", desc: "Personal finance manager", defaultPort: 8080, websockets: false, http2: true, extraDirectives: [], notes: "Personal finance manager — standard HTTP." },
  actual: { id: "actual", label: "Actual Budget", emoji: "💵", category: "Finance", desc: "Privacy-first budgeting app", defaultPort: 5006, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on for budget sync." },

  // ---------------- Bookmarks ----------------
  linkding: { id: "linkding", label: "Linkding", emoji: "🔖", category: "Bookmarks", desc: "Minimal bookmark manager", defaultPort: 9090, websockets: false, http2: true, extraDirectives: [], notes: "Bookmark manager — standard HTTP." },
  wallabag: { id: "wallabag", label: "Wallabag", emoji: "📰", category: "Bookmarks", desc: "Save articles to read later", defaultPort: 80, websockets: false, http2: true, extraDirectives: [], notes: "Read-it-later — standard HTTP." },

  // ---------------- Other ----------------
  bookstack: { id: "bookstack", label: "BookStack", emoji: "📚", category: "Other", desc: "Wiki & documentation platform", defaultPort: 80, websockets: false, http2: true, extraDirectives: ["client_max_body_size 1G;"], notes: "Larger body limit for image/attachment uploads." },
  wikijs: { id: "wikijs", label: "Wiki.js", emoji: "📖", category: "Other", desc: "Modern wiki platform", defaultPort: 3000, websockets: ws, http2: true, extraDirectives: ["client_max_body_size 500M;"], notes: "WebSocket on; larger body for asset uploads." },
  // ---------------- Expanded library (more popular self-hosted apps) ----------------
  // Media / Downloads
  prowlarr: { id: "prowlarr", label: "Prowlarr", emoji: "🔍", category: "Downloads", desc: "Indexer manager for the *arr apps", defaultPort: 9696, websockets: false, http2: true, extraDirectives: [], notes: "Indexer manager — standard HTTP. Set a base URL to share a domain." },
  bazarr: { id: "bazarr", label: "Bazarr", emoji: "🈂️", category: "Media", desc: "Subtitle downloader for Radarr & Sonarr", defaultPort: 6767, websockets: false, http2: true, extraDirectives: [], notes: "Subtitle manager — standard HTTP." },
  ombi: { id: "ombi", label: "Ombi", emoji: "🎫", category: "Media", desc: "Media request portal for Plex/Emby/Jellyfin", defaultPort: 3579, websockets: false, http2: true, extraDirectives: [], notes: "Media requests — standard HTTP." },
  kavita: { id: "kavita", label: "Kavita", emoji: "📗", category: "Media", desc: "Reader for comics, manga & ebooks", defaultPort: 5000, websockets: ws, http2: true, extraDirectives: ["client_max_body_size 1G;"], notes: "WebSocket on (SignalR) for live progress; ebook uploads." },
  komga: { id: "komga", label: "Komga", emoji: "📘", category: "Media", desc: "Comics & manga server with a web reader", defaultPort: 25600, websockets: false, http2: true, extraDirectives: ["client_max_body_size 1G;"], notes: "Larger body for comic uploads." },
  tdarr: { id: "tdarr", label: "Tdarr", emoji: "🎞️", category: "Media", desc: "Distributed media transcoding", defaultPort: 8265, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on for live jobs (UI 8265; node/server 8266 is separate)." },

  // Photos & Files
  duplicati: { id: "duplicati", label: "Duplicati", emoji: "💾", category: "Photos & Files", desc: "Encrypted, scheduled backups", defaultPort: 8200, websockets: false, http2: true, extraDirectives: [], notes: "Backup UI — standard HTTP." },
  backrest: { id: "backrest", label: "Backrest", emoji: "🗃️", category: "Photos & Files", desc: "Web UI & scheduler for restic backups", defaultPort: 9898, websockets: false, http2: true, extraDirectives: [], notes: "Backup UI — standard HTTP." },

  // Network & Admin
  guacamole: { id: "guacamole", label: "Apache Guacamole", emoji: "🖱️", category: "Network & Admin", desc: "Remote desktop (RDP/VNC/SSH) in your browser", defaultPort: 8080, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on (required) for the remote-desktop stream. The Tomcat image serves under /guacamole/ — set that path, or use the ROOT-deployed image." },
  dockge: { id: "dockge", label: "Dockge", emoji: "🐳", category: "Network & Admin", desc: "Manage Docker Compose stacks", defaultPort: 5001, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on for the live terminal & reactive UI." },
  komodo: { id: "komodo", label: "Komodo", emoji: "🛠️", category: "Network & Admin", desc: "Build & deploy containers across servers", defaultPort: 9120, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on for live logs / terminals." },
  pterodactyl: { id: "pterodactyl", label: "Pterodactyl", emoji: "🦖", category: "Network & Admin", desc: "Game-server management panel", defaultPort: 80, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on for the live game console (Wings daemon runs separately)." },
  headscale: { id: "headscale", label: "Headscale", emoji: "🛰️", category: "Network & Admin", desc: "Self-hosted Tailscale control server", defaultPort: 8080, websockets: ws, http2: false, extraDirectives: [], notes: "WebSocket on; HTTP/2 OFF on purpose — it can break the long-poll control channel." },
  netbird: { id: "netbird", label: "NetBird", emoji: "🌐", category: "Network & Admin", desc: "Mesh VPN with SSO & a web dashboard", defaultPort: 80, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on; the management/signal gRPC services need their own proxying." },
  ztnet: { id: "ztnet", label: "ZTnet (ZeroTier)", emoji: "🔗", category: "Network & Admin", desc: "Web controller for ZeroTier networks", defaultPort: 3000, websockets: false, http2: true, extraDirectives: [], notes: "Set NEXTAUTH_URL to the public address." },
  technitium: { id: "technitium", label: "Technitium DNS", emoji: "🧬", category: "Network & Admin", desc: "DNS server with ad-blocking & web UI", defaultPort: 5380, websockets: false, http2: true, extraDirectives: [], notes: "Web console on 5380; DNS itself serves on 53." },
  netbox: { id: "netbox", label: "NetBox", emoji: "🗺️", category: "Network & Admin", desc: "IP address & infrastructure source of truth", defaultPort: 8080, websockets: false, http2: true, extraDirectives: [], notes: "Set ALLOWED_HOSTS / CSRF_TRUSTED_ORIGINS for the proxied domain." },
  phpipam: { id: "phpipam", label: "phpIPAM", emoji: "📇", category: "Network & Admin", desc: "Web IP address management", defaultPort: 80, websockets: false, http2: true, extraDirectives: [], notes: "IPAM — standard HTTP." },

  // Monitoring
  prometheus: { id: "prometheus", label: "Prometheus", emoji: "🔥", category: "Monitoring", desc: "Time-series metrics database & scraper", defaultPort: 9090, websockets: false, http2: true, extraDirectives: [], notes: "No auth by default — gate it behind login / access control." },
  zabbix: { id: "zabbix", label: "Zabbix", emoji: "📟", category: "Monitoring", desc: "Network & server monitoring", defaultPort: 8080, websockets: false, http2: true, extraDirectives: [], notes: "Web frontend on 8080; server 10051 / agents 10050 are separate." },
  librenms: { id: "librenms", label: "LibreNMS", emoji: "📶", category: "Monitoring", desc: "Auto-discovering SNMP network monitoring", defaultPort: 8000, websockets: false, http2: true, extraDirectives: [], notes: "Network monitoring — standard HTTP." },
  beszel: { id: "beszel", label: "Beszel", emoji: "🐿️", category: "Monitoring", desc: "Lightweight server resource monitor", defaultPort: 8090, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on for realtime updates (PocketBase hub)." },
  scrutiny: { id: "scrutiny", label: "Scrutiny", emoji: "💽", category: "Monitoring", desc: "S.M.A.R.T. drive-health dashboard", defaultPort: 8080, websockets: false, http2: true, extraDirectives: [], notes: "Drive-health dashboard — standard HTTP." },
  speedtest: { id: "speedtest", label: "Speedtest Tracker", emoji: "🚄", category: "Monitoring", desc: "Tracks internet speed over time", defaultPort: 80, websockets: false, http2: true, extraDirectives: [], notes: "Container serves on 80 (HTTPS on 443 available)." },
  umami: { id: "umami", label: "Umami", emoji: "📉", category: "Monitoring", desc: "Privacy-friendly web analytics", defaultPort: 3000, websockets: false, http2: true, extraDirectives: [], notes: "Web analytics — standard HTTP." },
  plausible: { id: "plausible", label: "Plausible", emoji: "🧮", category: "Monitoring", desc: "Privacy-first web analytics", defaultPort: 8000, websockets: false, http2: true, extraDirectives: [], notes: "Needs ClickHouse + PostgreSQL." },
  matomo: { id: "matomo", label: "Matomo", emoji: "📐", category: "Monitoring", desc: "Full Google Analytics alternative", defaultPort: 80, websockets: false, http2: true, extraDirectives: ["client_max_body_size 200M;"], notes: "PHP app on 80; larger body for imports." },

  // Productivity & Office
  planka: { id: "planka", label: "Planka", emoji: "🧷", category: "Productivity & Office", desc: "Realtime Trello-style kanban boards", defaultPort: 1337, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on for realtime board updates." },
  focalboard: { id: "focalboard", label: "Focalboard", emoji: "🗒️", category: "Productivity & Office", desc: "Project & task boards (Notion-style)", defaultPort: 8000, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on for live board sync." },
  wekan: { id: "wekan", label: "Wekan", emoji: "🃏", category: "Productivity & Office", desc: "Open-source kanban board", defaultPort: 8080, websockets: ws, http2: true, extraDirectives: [], notes: "WebSocket on; set ROOT_URL to the public address." },
  nocodb: { id: "nocodb", label: "NocoDB", emoji: "🔢", category: "Productivity & Office", desc: "Open-source Airtable alternative", defaultPort: 8080, websockets: ws, http2: true, extraDirectives: ["client_max_body_size 1G;"], notes: "WebSocket on for collaboration; larger body for imports." },
  stirlingpdf: { id: "stirlingpdf", label: "Stirling PDF", emoji: "📑", category: "Productivity & Office", desc: "Edit & convert PDFs in the browser", defaultPort: 8080, websockets: false, http2: true, extraDirectives: ["client_max_body_size 500M;"], notes: "Larger body for PDF uploads; no auth unless DOCKER_ENABLE_SECURITY=true." },
  tandoor: { id: "tandoor", label: "Tandoor Recipes", emoji: "🥘", category: "Productivity & Office", desc: "Recipe manager & meal planner", defaultPort: 80, websockets: false, http2: true, extraDirectives: ["client_max_body_size 200M;"], notes: "Bundles nginx on 80; larger body for imports / images." },
  grocy: { id: "grocy", label: "Grocy", emoji: "🛒", category: "Productivity & Office", desc: "Groceries & household inventory", defaultPort: 80, websockets: false, http2: true, extraDirectives: [], notes: "Household management — standard HTTP." },
  snipeit: { id: "snipeit", label: "Snipe-IT", emoji: "🏷️", category: "Productivity & Office", desc: "IT asset & license management", defaultPort: 80, websockets: false, http2: true, extraDirectives: ["client_max_body_size 200M;"], notes: "Asset management; larger body for imports." },
  kimai: { id: "kimai", label: "Kimai", emoji: "⏱️", category: "Productivity & Office", desc: "Time-tracking for teams & freelancers", defaultPort: 8001, websockets: false, http2: true, extraDirectives: [], notes: "Time-tracking — standard HTTP." },

  // Communication
  mastodon: { id: "mastodon", label: "Mastodon", emoji: "🐘", category: "Communication", desc: "Federated microblogging server", defaultPort: 3000, websockets: ws, http2: true, extraDirectives: ["client_max_body_size 100M;"], notes: "WebSocket on for the streaming API (web 3000, streaming 4000 internally); media uploads." },

  // Other (wiki, RSS, CMS)
  freshrss: { id: "freshrss", label: "FreshRSS", emoji: "🗞️", category: "Other", desc: "RSS feed aggregator & reader", defaultPort: 80, websockets: false, http2: true, extraDirectives: [], notes: "Container serves on 80 — standard HTTP." },
  miniflux: { id: "miniflux", label: "Miniflux", emoji: "📜", category: "Other", desc: "Minimalist, fast RSS reader", defaultPort: 8080, websockets: false, http2: true, extraDirectives: [], notes: "Requires PostgreSQL." },
  outline: { id: "outline", label: "Outline", emoji: "📔", category: "Other", desc: "Team knowledge base & wiki", defaultPort: 3000, websockets: ws, http2: true, extraDirectives: ["client_max_body_size 100M;"], notes: "WebSocket on for realtime editing; requires SSO / OAuth." },
  docmost: { id: "docmost", label: "Docmost", emoji: "📙", category: "Other", desc: "Collaborative wiki & documentation", defaultPort: 3000, websockets: ws, http2: true, extraDirectives: ["client_max_body_size 100M;"], notes: "WebSocket on for live collaborative editing." },
  ghost: { id: "ghost", label: "Ghost", emoji: "👻", category: "Other", desc: "Publishing platform for blogs & newsletters", defaultPort: 2368, websockets: false, http2: true, extraDirectives: ["client_max_body_size 100M;"], notes: "Set url to the public address; admin lives under /ghost." },
  wordpress: { id: "wordpress", label: "WordPress", emoji: "✍️", category: "Other", desc: "Classic CMS & blogging platform", defaultPort: 80, websockets: false, http2: true, extraDirectives: ["client_max_body_size 256M;"], notes: "Forward proxy headers / set the site URL to avoid redirect loops." },

  custom: { id: "custom", label: "Custom / Generic", emoji: "⚙️", category: "Other", desc: "Anything else — sensible defaults", defaultPort: 8080, websockets: false, http2: true, extraDirectives: [], notes: "Sensible defaults + a WebSocket toggle you can flip later." },
};

export function getPreset(id: string): Preset {
  return PRESETS[id] ?? PRESETS.custom;
}
