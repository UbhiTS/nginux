import { useRef, useState } from "react";
import { api } from "../api.ts";
import { Icon } from "../icons.tsx";

interface Props {
  userId: string;
  /** Used for the initial fallback when there's no uploaded image. */
  name: string;
  /** When true, clicking opens a file picker to upload a new photo. */
  editable?: boolean;
  /** Called after a successful upload/remove (e.g. to refresh other avatars). */
  onChanged?: () => void;
}

/** Load a File into an <img>, cover-crop it to a square, and return a small JPEG
 *  data URL - keeps uploads tiny so no image library is needed server-side. */
function fileToAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    // Read the file as a data: URL, not a blob: URL: the app's CSP is
    // `img-src 'self' data:`, which blocks blob: image loads - so a blob URL here
    // makes the <img> fail to load and every upload silently breaks.
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const size = 256;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Canvas unavailable."));
        const scale = Math.max(size / img.width, size / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => reject(new Error("Couldn't read that image."));
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

export function Avatar({ userId, name, editable = false, onChanged }: Props) {
  const [version, setVersion] = useState(0);
  // Start by trying the image; onError flips to the initial. A successful upload
  // bumps `version`, which both cache-busts the URL and re-arms the <img>.
  const [showImg, setShowImg] = useState(true);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const initial = (name?.[0] ?? "?").toUpperCase();

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) { alert("Pick an image file (PNG, JPEG, or WebP)."); return; }
    setBusy(true);
    try {
      const dataUrl = await fileToAvatar(file);
      await api.uploadAvatar(dataUrl);
      setVersion((v) => v + 1);
      setShowImg(true);
      onChanged?.();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Couldn't update your photo.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`avatar${editable ? " avatar-edit" : ""}`}
      onClick={editable && !busy ? () => fileRef.current?.click() : undefined}
      title={editable ? "Change photo" : undefined}
      role={editable ? "button" : undefined}
      tabIndex={editable ? 0 : undefined}
      onKeyDown={editable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileRef.current?.click(); } } : undefined}
    >
      {/* Initials underlay always renders, so there's never a blank avatar while the
          image is still loading (or if it never resolves). The <img> paints over it. */}
      <span aria-hidden="true">{initial}</span>
      {showImg && (
        <img
          src={api.avatarUrl(userId, version)}
          alt=""
          loading="lazy"
          onError={() => setShowImg(false)}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
        />
      )}
      {editable && <span className="avatar-cam">{busy ? <span className="spinner" /> : <Icon.camera />}</span>}
      {editable && <input ref={fileRef} type="file" hidden accept="image/*" onChange={onPick} />}
    </div>
  );
}
