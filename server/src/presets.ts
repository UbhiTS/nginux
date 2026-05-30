// App presets encode the correct headers / WebSocket / timeout behaviour for
// popular self-hosted apps, so the "no Google needed" promise holds.

export interface Preset {
  id: string;
  label: string;
  emoji: string;
  websockets: boolean;
  http2: boolean;
  /** Extra nginx directives baked into the location block. */
  extraDirectives: string[];
  notes: string;
}

export const PRESETS: Record<string, Preset> = {
  plex: {
    id: "plex",
    label: "Plex / Jellyfin",
    emoji: "🎬",
    websockets: true,
    http2: true,
    extraDirectives: ["proxy_buffering off;"],
    notes: "WebSocket on, large buffers, streaming-friendly timeouts.",
  },
  homeassistant: {
    id: "homeassistant",
    label: "Home Assistant",
    emoji: "🏠",
    websockets: true,
    http2: true,
    // The base location already sets Host / X-Real-IP / X-Forwarded-For /
    // X-Forwarded-Proto. Re-adding X-Forwarded-Proto here sent it twice, which
    // Home Assistant rejects ("Incorrect number of elements in X-Forwarded-Proto").
    extraDirectives: [],
    notes: "WebSocket on. In Home Assistant set http.use_x_forwarded_for + trusted_proxies (the NginUX container IP).",
  },
  nextcloud: {
    id: "nextcloud",
    label: "Nextcloud",
    emoji: "☁️",
    websockets: false,
    http2: true,
    extraDirectives: ["client_max_body_size 10G;"],
    notes: "Large upload limits, security headers, .well-known redirects.",
  },
  immich: {
    id: "immich",
    label: "Immich",
    emoji: "📷",
    websockets: true,
    http2: true,
    extraDirectives: ["client_max_body_size 50G;"],
    notes: "Large upload limits for photo/video sync.",
  },
  portainer: {
    id: "portainer",
    label: "Portainer",
    emoji: "📦",
    websockets: true,
    http2: true,
    extraDirectives: [],
    notes: "WebSocket on for console/exec.",
  },
  grafana: {
    id: "grafana",
    label: "Grafana",
    emoji: "📊",
    websockets: true,
    http2: true,
    extraDirectives: [],
    notes: "WebSocket on for live, sub-path support.",
  },
  proxmox: {
    id: "proxmox",
    label: "Proxmox",
    emoji: "🖥️",
    websockets: true,
    http2: true,
    extraDirectives: [],
    notes: "WebSocket on for noVNC console, long timeouts.",
  },
  vaultwarden: {
    id: "vaultwarden",
    label: "Vaultwarden",
    emoji: "🔐",
    websockets: true,
    http2: true,
    extraDirectives: ["client_max_body_size 128M;"],
    notes: "Security headers, WebSocket notifications path.",
  },
  custom: {
    id: "custom",
    label: "Custom / Generic",
    emoji: "⚙️",
    websockets: false,
    http2: true,
    extraDirectives: [],
    notes: "Sensible defaults + WebSocket toggle.",
  },
};

export function getPreset(id: string): Preset {
  return PRESETS[id] ?? PRESETS.custom;
}
