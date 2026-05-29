import { Icon } from "../icons.tsx";

export function Placeholder({ title, body }: { title: string; body: string }) {
  return (
    <>
      <div className="topbar">
        <h1>{title}</h1>
      </div>
      <div className="content">
        <div className="card">
          <div className="placeholder">
            <div className="ph-icon">
              <Icon.shield />
            </div>
            <h2>{title}</h2>
            <p>{body}</p>
            <p style={{ marginTop: 14 }}>
              <span className="pill n">Designed in the mockup · coming in a later phase</span>
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
