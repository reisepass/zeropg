export type Status = 'todo' | 'doing' | 'done'
export const STATUSES: Status[] = ['todo', 'doing', 'done']

export interface Board {
  id: number
  name: string
}

export interface Task {
  id: number
  boardId: number
  title: string
  status: Status
}

/** The data layer both ORMs implement, so the HTTP app is ORM-agnostic. */
export interface Store {
  /** Create tables if absent (idempotent). */
  init(): Promise<void>
  listBoards(): Promise<Board[]>
  getBoard(id: number): Promise<{ board: Board; tasks: Task[] } | null>
  createBoard(name: string): Promise<Board>
  addTask(boardId: number, title: string): Promise<void>
  /** Advance a task's status todo -> doing -> done -> todo. */
  cycleTask(id: number): Promise<void>
  deleteTask(id: number): Promise<void>
  close(): Promise<void>
}
