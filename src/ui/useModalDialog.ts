import { useEffect, useRef, type RefObject } from 'react'

const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function useModalDialog<T extends HTMLElement>(onClose: () => void, initialFocus?: RefObject<HTMLElement | null>) {
  const dialogRef = useRef<T>(null)
  const triggerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return undefined
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const layer = dialog.parentElement
    const workspace = layer?.parentElement?.closest('.workspace-shell') ?? layer?.parentElement
    const background = workspace ? Array.from(workspace.children).filter((child) => child !== layer) : []
    const inertState = background.map((element) => ({ element, wasInert: element.hasAttribute('inert') }))
    background.forEach((element) => element.setAttribute('inert', ''))

    const close = () => onClose()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return }
      if (event.key !== 'Tab') return
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable.at(-1)!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    dialog.addEventListener('keydown', onKeyDown)
    ;(initialFocus?.current ?? dialog.querySelector<HTMLElement>(focusableSelector))?.focus()

    return () => {
      dialog.removeEventListener('keydown', onKeyDown)
      inertState.forEach(({ element, wasInert }) => { if (!wasInert) element.removeAttribute('inert') })
      queueMicrotask(() => triggerRef.current?.focus())
    }
  }, [initialFocus, onClose])

  return dialogRef
}
