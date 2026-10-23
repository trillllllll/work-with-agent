"use client"

import * as React from "react"
import { cn } from "cn"
import { Tooltip as TooltipPrimitive } from "radix-ui"

/**
 * Coarse-pointer press reduced to a gesture. Fine pointers stay on Radix
 * hover and focus; this state machine only runs for `(pointer: coarse)`.
 */
export const COARSE_LONG_PRESS_MS = 400
const COARSE_MOVE_PX = 10

export type CoarseTooltipGesture = "tap" | "long-press" | "outside" | "escape"

export function nextCoarseTooltipOpen(open: boolean, gesture: CoarseTooltipGesture): boolean {
  switch (gesture) {
    case "tap":
      return !open
    case "long-press":
      return true
    case "outside":
    case "escape":
      return false
  }
}

export type CoarsePressSession = {
  x: number
  y: number
  moved: boolean
  longPressed: boolean
}

export type CoarsePressSample = { x: number; y: number; phase: "down" | "move" | "up" | "cancel" }

export type CoarsePressStep = {
  session: CoarsePressSession | null
  /** Set when this sample completes a tap. Long-press is reported by `markCoarseLongPress`. */
  gesture: "tap" | null
  armTimer: boolean
  disarmTimer: boolean
}

/** Advance a coarse press. A move past 10px cancels the long-press and is not a tap. */
export function reduceCoarsePress(session: CoarsePressSession | null, sample: CoarsePressSample): CoarsePressStep {
  if (sample.phase === "down") {
    return {
      session: { x: sample.x, y: sample.y, moved: false, longPressed: false },
      gesture: null,
      armTimer: true,
      disarmTimer: false,
    }
  }
  if (!session) return { session: null, gesture: null, armTimer: false, disarmTimer: false }
  if (sample.phase === "move") {
    const moved = session.moved || Math.hypot(sample.x - session.x, sample.y - session.y) > COARSE_MOVE_PX
    return {
      session: moved === session.moved ? session : { ...session, moved },
      gesture: null,
      armTimer: false,
      disarmTimer: moved && !session.moved,
    }
  }
  if (sample.phase === "cancel" || session.moved || session.longPressed) {
    return { session: null, gesture: null, armTimer: false, disarmTimer: true }
  }
  return { session: null, gesture: "tap", armTimer: false, disarmTimer: true }
}

export function markCoarseLongPress(session: CoarsePressSession): { session: CoarsePressSession; gesture: "long-press" } {
  return { session: { ...session, longPressed: true }, gesture: "long-press" }
}

/** Falsy content skips the tooltip and renders children directly. */
export function hasTooltipContent(content: React.ReactNode): boolean {
  return Boolean(content)
}

/** Always-available accessible text when Radix has not opened the tooltip yet. */
export function tooltipFallbackText(content: React.ReactNode): string | null {
  if (typeof content === "string") {
    const trimmed = content.trim()
    return trimmed ? trimmed : null
  }
  if (typeof content === "number") return String(content)
  return null
}

export function isCoarsePointer(matches: (query: string) => boolean = defaultMatchMedia): boolean {
  return matches("(pointer: coarse)")
}

function defaultMatchMedia(query: string): boolean {
  try {
    if (typeof matchMedia !== "function") return false
    return matchMedia(query).matches
  } catch {
    return false
  }
}

function useCoarsePointer() {
  const [coarse, setCoarse] = React.useState(() => isCoarsePointer())
  React.useEffect(() => {
    if (typeof matchMedia !== "function") return
    const media = matchMedia("(pointer: coarse)")
    const onChange = () => setCoarse(media.matches)
    media.addEventListener?.("change", onChange)
    setCoarse(media.matches)
    return () => media.removeEventListener?.("change", onChange)
  }, [])
  return coarse
}

function TooltipProvider({
  delayDuration = 300,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />
}

function TooltipRoot({
  delayDuration = 300,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" delayDuration={delayDuration} {...props} />
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        side={side}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          // Dialog (WorkspaceModal) is z-50. Keep the bubble above it.
          "z-[60] glass-overlay max-w-60 px-3 py-1.5 text-xs text-popover-foreground outline-hidden",
          "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-[60] size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] border-r border-b border-border bg-popover fill-popover" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

type TooltipProps = {
  content: React.ReactNode
  side?: React.ComponentProps<typeof TooltipPrimitive.Content>["side"]
  align?: React.ComponentProps<typeof TooltipPrimitive.Content>["align"]
  delayDuration?: number
  /** Wrap the trigger so a `disabled` button (pointer-events-none) can still show the tip. */
  disabledTrigger?: boolean
  className?: string
  contentClassName?: string
  contentProps?: Pick<React.ComponentProps<typeof TooltipPrimitive.Content>, "onPointerDown" | "onMouseDown" | "onTouchStart" | "onClick">
  children: React.ReactNode
}

function Tooltip({
  content,
  side = "top",
  align = "center",
  delayDuration = 300,
  disabledTrigger = false,
  className,
  contentClassName,
  contentProps,
  children,
}: TooltipProps) {
  const coarse = useCoarsePointer()
  if (!hasTooltipContent(content)) return children
  // Remount when the pointer class changes so Radix stays controlled or uncontrolled for its whole life.
  return (
    <TooltipInteraction
      key={coarse ? "coarse" : "fine"}
      content={content}
      side={side}
      align={align}
      delayDuration={delayDuration}
      disabledTrigger={disabledTrigger}
      className={className}
      contentClassName={contentClassName}
      contentProps={contentProps}
      coarse={coarse}
    >
      {children}
    </TooltipInteraction>
  )
}

function TooltipInteraction({
  content,
  side,
  align,
  delayDuration,
  disabledTrigger,
  className,
  contentClassName,
  contentProps,
  coarse,
  children,
}: TooltipProps & { coarse: boolean }) {
  const [open, setOpen] = React.useState(false)
  const sessionRef = React.useRef<CoarsePressSession | null>(null)
  const timerRef = React.useRef<number | null>(null)
  const pressIdRef = React.useRef(0)
  // Radix closes on pointerdown and click. Ignore those until the click that follows pointerup has run.
  const suppressCloseRef = React.useRef(false)

  const clearTimer = React.useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  React.useEffect(() => clearTimer, [clearTimer])

  const apply = (gesture: CoarseTooltipGesture) => {
    setOpen((current) => nextCoarseTooltipOpen(current, gesture))
  }

  const onPointerDown = (event: React.PointerEvent) => {
    if (!coarse) return
    pressIdRef.current += 1
    suppressCloseRef.current = true
    const step = reduceCoarsePress(null, { x: event.clientX, y: event.clientY, phase: "down" })
    sessionRef.current = step.session
    clearTimer()
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      const session = sessionRef.current
      if (!session || session.moved || session.longPressed) return
      const marked = markCoarseLongPress(session)
      sessionRef.current = marked.session
      apply(marked.gesture)
    }, COARSE_LONG_PRESS_MS)
  }

  const onPointerMove = (event: React.PointerEvent) => {
    if (!coarse || !sessionRef.current) return
    const step = reduceCoarsePress(sessionRef.current, { x: event.clientX, y: event.clientY, phase: "move" })
    sessionRef.current = step.session
    if (step.disarmTimer) clearTimer()
  }

  const finishPress = (phase: "up" | "cancel", event: React.PointerEvent) => {
    if (!coarse) return
    const step = reduceCoarsePress(sessionRef.current, { x: event.clientX, y: event.clientY, phase })
    sessionRef.current = step.session
    if (step.disarmTimer) clearTimer()
    if (step.gesture) apply(step.gesture)
  }

  const releaseSuppressAfterClick = () => {
    const pressId = pressIdRef.current
    // pointerup, mouseup, and click are one task. A timeout runs after that click.
    window.setTimeout(() => {
      if (pressIdRef.current === pressId) suppressCloseRef.current = false
    }, 0)
  }

  const fallback = disabledTrigger ? tooltipFallbackText(content) : null
  const trigger = disabledTrigger ? (
    <span tabIndex={0} className={cn("inline-flex", className)}>
      {children}
      {fallback != null && <span className="sr-only">{fallback}</span>}
    </span>
  ) : (
    children
  )

  return (
    <TooltipProvider delayDuration={delayDuration}>
      <TooltipRoot
        delayDuration={delayDuration}
        open={coarse ? open : undefined}
        onOpenChange={(next) => {
          if (!coarse) return
          if (!next && suppressCloseRef.current) return
          setOpen(next)
        }}
      >
        <TooltipTrigger
          asChild
          className={disabledTrigger ? undefined : className}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(event) => {
            finishPress("up", event)
            if (coarse) releaseSuppressAfterClick()
          }}
          onPointerCancel={(event) => {
            finishPress("cancel", event)
            suppressCloseRef.current = false
          }}
        >
          {trigger}
        </TooltipTrigger>
        <TooltipContent {...contentProps} side={side} align={align} className={contentClassName}>
          {content}
        </TooltipContent>
      </TooltipRoot>
    </TooltipProvider>
  )
}

export { Tooltip, TooltipProvider, TooltipRoot, TooltipTrigger, TooltipContent }
