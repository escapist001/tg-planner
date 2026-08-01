import { describe, it, expect } from 'vitest'
import { detectAssignee } from '../src/assignee.js'

describe('detectAssignee', () => {
  it('по умолчанию — автор', () => {
    expect(detectAssignee('купить корм', 'danya').assignee).toBe('danya')
    expect(detectAssignee('купить корм', 'zhenya').assignee).toBe('zhenya')
  })

  it('обращение к Жене', () => {
    const r = detectAssignee('Жень, купи корм коту', 'danya')
    expect(r.assignee).toBe('zhenya')
    expect(r.text).toBe('купи корм коту')
  })

  it('обращение к Дане', () => {
    expect(detectAssignee('Дань, забери посылку', 'zhenya').assignee).toBe('danya')
  })

  it('«нам надо» -> оба', () => {
    expect(detectAssignee('нам надо к нотариусу', 'danya').assignee).toBe('both')
  })

  it('«вместе» -> оба', () => {
    expect(detectAssignee('вместе выбрать торт', 'zhenya').assignee).toBe('both')
  })

  it('не путает имя внутри слова', () => {
    expect(detectAssignee('купить женьшень', 'danya').assignee).toBe('danya')
  })
})
