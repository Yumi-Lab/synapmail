"use client"

import * as React from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

const TABBABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  cancelLabel: string
  confirmLabel: string
  pendingLabel: string
  errorLabel: string
  onConfirm: () => Promise<void> | void
}

function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  cancelLabel,
  confirmLabel,
  pendingLabel,
  errorLabel,
  onConfirm,
}: ConfirmDialogProps) {
  const [pending, setPending] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const id = React.useId()

  React.useEffect(() => {
    if (open) setFailed(false)
  }, [open])

  const handleOpenChange = (next: boolean) => {
    if (pending) return
    onOpenChange(next)
  }

  const handleOpenChangeRef = React.useRef(handleOpenChange)
  handleOpenChangeRef.current = handleOpenChange

  // modal="trap-focus" keeps the page behind clickable (modal=true would make
  // it inert), which is what lets one click both close the dialog and hit its
  // target. Measured with a real mouse on the full /settings/api-keys page
  // (not the intercepted settings window), base-ui's own outside-press
  // dismissal and focus trap did not hold in that mode, so both are enforced
  // here: close on a capture-phase pointerdown outside the popup (no
  // preventDefault, so the click still reaches its target) and wrap Tab inside
  // the popup. Escape stays with base-ui's onOpenChange. Both are inert while
  // pending via handleOpenChange.
  React.useEffect(() => {
    if (!open) return
    const selector = `[data-confirm-dialog="${id}"]`
    const onPointerDown = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest(selector)) return
      handleOpenChangeRef.current(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return
      const popup = document.querySelector<HTMLElement>(selector)
      if (!popup) return
      const tabbables = Array.from(popup.querySelectorAll<HTMLElement>(TABBABLE))
      const active = document.activeElement
      if (tabbables.length === 0) {
        e.preventDefault()
        popup.focus()
        return
      }
      const first = tabbables[0]
      const last = tabbables[tabbables.length - 1]
      if (!popup.contains(active)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      } else if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    document.addEventListener("keydown", onKeyDown, true)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true)
      document.removeEventListener("keydown", onKeyDown, true)
    }
  }, [open, id])

  const handleConfirm = async () => {
    setPending(true)
    setFailed(false)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch {
      setFailed(true)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange} modal="trap-focus">
      <DialogContent
        showCloseButton={false}
        overlayClassName="pointer-events-none"
        data-confirm-dialog={id}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {failed && (
          <p role="alert" className="text-sm text-destructive">
            {errorLabel}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => handleOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button variant="destructive" disabled={pending} onClick={handleConfirm}>
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export { ConfirmDialog }
