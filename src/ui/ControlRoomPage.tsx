import { useState } from 'react'
import { ProjectSidebar } from './ProjectSidebar'
import { TaskBoard } from './TaskBoard'
import { TaskInspector } from './TaskInspector'
import type { ControlRoomService } from './use-control-room'
import { useControlRoom } from './use-control-room'

interface ControlRoomPageProps {
  service: ControlRoomService
}

export function ControlRoomPage({ service }: ControlRoomPageProps) {
  const snapshot = useControlRoom(service)
  const [selectedTaskId, setSelectedTaskId] = useState('review-rate-limit')
  const selectedTask = snapshot.tasks.find((task) => task.id === selectedTaskId) ?? snapshot.tasks[0]

  if (!selectedTask) return null

  return (
    <main className="control-room-page">
      <h1 className="control-room-title">控制室</h1>
      <aside className="project-panel" aria-label="项目与 Agent 席位">
        <ProjectSidebar
          projectName={snapshot.projectName}
          branch={snapshot.branch}
          agents={snapshot.agents}
        />
      </aside>
      <section className="board-panel" aria-label="任务看板">
        <TaskBoard
          tasks={snapshot.tasks}
          agents={snapshot.agents}
          selectedTaskId={selectedTask.id}
          onSelectTask={setSelectedTaskId}
        />
      </section>
      <aside className="inspector-panel" aria-label="任务详情与审查">
        <TaskInspector
          task={selectedTask}
          onRequestSummary={service.requestSummary}
          onRequestDecision={service.requestDecision}
          onSendFeedback={service.sendFeedback}
          onAccept={service.accept}
          onReject={service.reject}
        />
      </aside>
    </main>
  )
}
