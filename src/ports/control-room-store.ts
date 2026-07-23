import type { ControlRoomSnapshot } from '../domain/control-room'

export interface ControlRoomStore {
  getSnapshot(): ControlRoomSnapshot
  replace(snapshot: ControlRoomSnapshot): void
  subscribe(listener: () => void): () => void
}
