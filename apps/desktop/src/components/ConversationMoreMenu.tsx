import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { SessionSummary } from "@pi-desktop/shared";
import { portalToBody } from "../lib/portal-visibility";
import { useAppStore } from "../stores/app-store";
import { IconMore } from "./icons";
import { SessionRenameDialog } from "./SessionRenameDialog";
import { SidebarMenuPanel } from "./SidebarMenuPanel";
import { TooltipButton } from "./ui";
import { useSessionMenuContent } from "./useSessionMenuContent";

export function ConversationMoreMenu({ session }: { session: SessionSummary }) {
  const { t } = useTranslation();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const firstItem = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [rename, setRename] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);
  const closeRename = useCallback(() => {
    setRename(false);
    trigger.current?.focus();
  }, []);
  const content = useSessionMenuContent(open ? session : undefined, {
    onClose: close,
    onRename: () => setRename(true),
  });

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const surface = menu.current;
      if (!anchor || !surface) return;
      const left = Math.max(8, Math.min(anchor.right, window.innerWidth - 8) - surface.offsetWidth);
      const top = Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - surface.offsetHeight - 8));
      setPosition((previous) => previous.left === left && previous.top === top ? previous : { left, top });
    };
    place();
    firstItem.current?.focus();
    const observer = new ResizeObserver(place);
    if (menu.current) observer.observe(menu.current);
    window.addEventListener("resize", place);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (trigger.current?.contains(target) || menu.current?.contains(target) || target.closest(".sidebar-submenu")) return;
      close(false);
    };
    const blur = () => close(false);
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("blur", blur);
    };
  }, [close, open]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") close();
  };
  const label = t("nav.sessionActions");
  return (
    <>
      <TooltipButton ref={trigger} type="button" className="ct-icon-btn" data-nav="conversation-more"
        tooltip={label} ariaLabel={label} aria-haspopup="menu" aria-expanded={open}
        onClick={() => open ? close() : setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); }
        }}>
        <IconMore size={15} aria-hidden />
      </TooltipButton>
      {open && content && portalToBody(
        <SidebarMenuPanel className="conversation-more-menu" content={content} menuRef={menu} firstItemRef={firstItem}
          position={position} onKeyDown={onMenuKeyDown} />,
      )}
      {rename && <SessionRenameDialog session={session} onClose={closeRename}
        onSave={(title) => useAppStore.getState().renameSession(session.id, title)}
        onError={(error) => useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), { variant: "error" })} />}
    </>
  );
}
