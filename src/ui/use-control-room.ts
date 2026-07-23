import { useSyncExternalStore } from 'react'
import type { createControlRoomService } from '../application/control-room-service'

export type ControlRoomService = ReturnType<typeof createControlRoomService>

export function useControlRoom(service: ControlRoomService) {
  return useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot)
}
