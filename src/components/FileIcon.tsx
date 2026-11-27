import { useIsDark } from "../theme";
import { useTheming } from "../theming/store";
import { resolveIcon, useAsset, type ResolvedIcon } from "../theming/iconTheme";

/** File/folder icon from the active VS Code icon theme (workbench.iconTheme). */
export function FileIcon({ name, dir, open, size = 16 }: { name: string; dir?: boolean; open?: boolean; size?: number }) {
  const light = !useIsDark();
  const theme = useTheming((s) => s.iconTheme);
  if (!theme) return <span className="file-icon" style={{ width: size, height: size }} />;
  const icon = resolveIcon(theme, name, { dir, open, light });
  return <Icon icon={icon} size={size} />;
}

function Icon({ icon, size }: { icon: ResolvedIcon | null; size: number }) {
  const assetUrl = useAsset(icon?.kind === "asset" ? icon.path : null);
  const box = { width: size, height: size };
  if (!icon) return <span className="file-icon" style={box} />;
  if (icon.kind === "glyph") {
    const pct = icon.size?.endsWith("%") ? parseFloat(icon.size) / 100 : 1;
    return (
      <span
        className="file-icon file-icon-glyph"
        style={{ ...box, fontFamily: icon.family, color: icon.color, fontSize: Math.round(size * pct), lineHeight: `${size}px` }}
      >
        {icon.char}
      </span>
    );
  }
  const src = icon.kind === "url" ? icon.url : assetUrl;
  if (!src) return <span className="file-icon" style={box} />;
  return <img className="file-icon" src={src} width={size} height={size} alt="" draggable={false} />;
}
