"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Navigate = (href: string) => void;

function assignLocation(href: string) {
  window.location.assign(href);
}

export function useUnsavedCalendarNavigation(
  hasChanges: boolean,
  navigate: Navigate = assignLocation,
) {
  const [pendingHref, setPendingHref] = useState<string>();
  const interruptedLinkRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      if (!hasChanges) return;
      event.preventDefault();
      event.returnValue = "";
    }

    function handleDocumentClick(event: MouseEvent) {
      if (
        !hasChanges
        || event.defaultPrevented
        || event.button !== 0
        || event.metaKey
        || event.ctrlKey
        || event.shiftKey
        || event.altKey
        || !(event.target instanceof Element)
      ) {
        return;
      }

      const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.hasAttribute("download")) return;
      if (anchor.target && anchor.target.toLowerCase() !== "_self") return;

      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;

      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      if (
        destination.pathname === window.location.pathname
        && destination.search === window.location.search
        && destination.hash !== window.location.hash
      ) {
        return;
      }

      event.preventDefault();
      interruptedLinkRef.current = anchor;
      setPendingHref(destination.href);
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("click", handleDocumentClick, true);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("click", handleDocumentClick, true);
    };
  }, [hasChanges]);

  const continueEditing = useCallback(() => {
    setPendingHref(undefined);
    interruptedLinkRef.current?.focus();
    interruptedLinkRef.current = null;
  }, []);

  const discardAndLeave = useCallback(() => {
    const href = pendingHref;
    setPendingHref(undefined);
    interruptedLinkRef.current = null;
    if (href) navigate(href);
  }, [navigate, pendingHref]);

  return { pendingHref, continueEditing, discardAndLeave };
}
