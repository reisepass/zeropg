import type { Board, Task, Status } from './types.ts'
import { STATUSES } from './types.ts'

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function layout(title: string, body: string, orm: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 880px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  a { color: #2563eb; text-decoration: none; } a:hover { text-decoration: underline; }
  .cols { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
  .col { background: #f4f4f5; border-radius: 8px; padding: .75rem; }
  .col h3 { margin: 0 0 .5rem; text-transform: capitalize; font-size: 13px; color: #71717a; }
  .task { background: #fff; border: 1px solid #e4e4e7; border-radius: 6px; padding: .5rem; margin-bottom: .5rem; }
  .task form { display: inline; }
  button { font: inherit; cursor: pointer; border: 1px solid #d4d4d8; background: #fff; border-radius: 5px; padding: .15rem .5rem; }
  input[type=text] { font: inherit; padding: .35rem .5rem; border: 1px solid #d4d4d8; border-radius: 5px; }
  .badge { font-size: 12px; color: #71717a; }
  form.row { display: flex; gap: .5rem; margin: 1rem 0; }
</style></head>
<body>
<p class="badge">task board · ORM: <strong data-testid="orm">${esc(orm)}</strong> · <a href="/">all boards</a></p>
${body}
</body></html>`
}

export function boardsPage(boards: Board[], orm: string): string {
  const items = boards.length
    ? `<ul data-testid="boards">${boards
        .map((b) => `<li><a data-testid="board-link" href="/boards/${b.id}">${esc(b.name)}</a></li>`)
        .join('')}</ul>`
    : `<p data-testid="empty">No boards yet.</p>`
  return layout(
    'Boards',
    `<h1>Boards</h1>
${items}
<form class="row" method="post" action="/boards">
  <input type="text" name="name" placeholder="New board name" data-testid="board-name" required>
  <button type="submit" data-testid="create-board">Create board</button>
</form>`,
    orm,
  )
}

export function boardPage(board: Board, tasks: Task[], orm: string): string {
  const col = (status: Status): string => {
    const inCol = tasks.filter((t) => t.status === status)
    const cards = inCol
      .map(
        (t) => `<div class="task" data-testid="task" data-status="${t.status}">
  <div>${esc(t.title)}</div>
  <form method="post" action="/tasks/${t.id}/cycle"><button data-testid="cycle">move &rarr;</button></form>
  <form method="post" action="/tasks/${t.id}/delete"><button data-testid="delete">x</button></form>
</div>`,
      )
      .join('')
    return `<div class="col"><h3 data-testid="col-${status}">${status} (${inCol.length})</h3>${cards}</div>`
  }
  return layout(
    board.name,
    `<h1 data-testid="board-title">${esc(board.name)}</h1>
<form class="row" method="post" action="/boards/${board.id}/tasks">
  <input type="text" name="title" placeholder="New task" data-testid="task-title" required>
  <button type="submit" data-testid="add-task">Add task</button>
</form>
<div class="cols">${STATUSES.map(col).join('')}</div>`,
    orm,
  )
}
