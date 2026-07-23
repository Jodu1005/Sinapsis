import { useMemo } from 'react'
import { createInMemoryControlRoomStore } from '../adapters/in-memory-control-room'
import { createControlRoomService } from '../application/control-room-service'
import { ControlRoomPage } from '../ui/ControlRoomPage'

export default function App() {
  const service = useMemo(
    () => createControlRoomService(createInMemoryControlRoomStore()),
    [],
  )

  return <ControlRoomPage service={service} />
}
