import { useState } from "react";

/** A service's icon: its image logo (a dashboard-icons CDN URL or an uploaded
 *  data: URL) when set, otherwise its emoji. If the image fails to load it falls
 *  back to the emoji, so the UI never shows a broken image. Emoji rendering is a
 *  bare fragment so it inherits the surrounding container's styling unchanged. */
export function ServiceIcon({ emoji, iconUrl, size = 20 }: {
  emoji: string;
  iconUrl?: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  if (iconUrl && !failed) {
    return (
      <img
        src={iconUrl}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size, objectFit: "contain", display: "inline-block", verticalAlign: "middle", borderRadius: 4 }}
        onError={() => setFailed(true)}
      />
    );
  }
  return <>{emoji}</>;
}
