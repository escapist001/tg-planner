// Внимание: в JS `\b` считает «словом» только ASCII ([A-Za-z0-9_]),
// поэтому рядом с кириллицей граница слова НИКОГДА не срабатывает.
// Вместо `\b` используем lookaround по юникодным буквам/цифрам (флаг `u`).

/** Следующий символ не буква и не цифра — то есть имя закончилось. */
const NOT_WORD_AHEAD = '(?![\\p{L}\\p{N}])'
/** Предыдущий символ не буква и не цифра — то есть слово началось. */
const NOT_WORD_BEHIND = '(?<![\\p{L}\\p{N}])'

/**
 * Обращение в начале текста: имя + разделитель (запятая/двоеточие или пробел),
 * после которого обязательно идёт сам текст задачи.
 * `NOT_WORD_AHEAD` не даёт «женьшеню» превратиться в обращение к Жене.
 */
const ZHENYA = new RegExp(
  `^\\s*(жен[яеь]|женёк|женька|женёчек|жека)${NOT_WORD_AHEAD}\\s*[,:!]*\\s*(?=\\S)`,
  'iu',
)

const DANYA = new RegExp(
  `^\\s*(дан[яеь]|данила|данёк|данёчек)${NOT_WORD_AHEAD}\\s*[,:!]*\\s*(?=\\S)`,
  'iu',
)

/** Маркеры совместного дела — в любом месте текста, но отдельными словами. */
const BOTH = new RegExp(
  `${NOT_WORD_BEHIND}(нам\\s+надо|нам\\s+нужно|вместе|обоим|обоих|вдвоём|вдвоем)${NOT_WORD_AHEAD}`,
  'iu',
)

/**
 * Определяет, на кого задача, и вырезает обращение из текста.
 * @param {string} text — исходная фраза
 * @param {'danya'|'zhenya'} authorRole — кто написал (он же исполнитель по умолчанию)
 * @returns {{assignee: 'danya'|'zhenya'|'both', text: string}}
 */
export function detectAssignee(text, authorRole) {
  if (!text) return { assignee: authorRole ?? 'both', text: '' }

  if (BOTH.test(text)) return { assignee: 'both', text: text.trim() }

  const z = text.match(ZHENYA)
  if (z) return { assignee: 'zhenya', text: text.slice(z[0].length).trim() }

  const d = text.match(DANYA)
  if (d) return { assignee: 'danya', text: text.slice(d[0].length).trim() }

  return { assignee: authorRole ?? 'both', text: text.trim() }
}
