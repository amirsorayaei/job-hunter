import * as React from "react"

const MOBILE_BREAKPOINT = 768
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

/**
 * Is the viewport phone-sized?
 *
 * `useSyncExternalStore` rather than the effect-plus-setState version shadcn
 * ships: the lint rule this project runs rejects a synchronous setState inside
 * an effect, and subscribing to matchMedia is exactly what this hook is for.
 * The server snapshot is `false`, so the desktop layout renders first and the
 * client corrects it during hydration.
 */
function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(QUERY)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

export function useIsMobile() {
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  )
}
