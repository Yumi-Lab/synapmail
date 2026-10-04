"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog"

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

  React.useEffect(() => {
    if (open) setFailed(false)
  }, [open])

  const handleOpenChange = (next: boolean) => {
    if (pending) return
    onOpenChange(next)
  }

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
      <DialogPortal>
        <DialogOverlay className="pointer-events-none" />
        <DialogPrimitive.Popup
          data-slot="dialog-content"
          className="fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
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
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  )
}

export { ConfirmDialog }
