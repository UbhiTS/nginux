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
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
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
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't read that image.")); };
    img.src = url;
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
      {showImg
        ? <img src={api.avatarUrl(userId, version)} alt="" onError={() => setShowImg(false)} />
        : <span>{initial}</span>}
      {editable && <span className="avatar-cam">{busy ? <span className="spinner" /> : <Icon.camera />}</span>}
      {editable && <input ref={fileRef} type="file" hidden accept="image/*" onChange={onPick} />}
    </div>
  );
}
