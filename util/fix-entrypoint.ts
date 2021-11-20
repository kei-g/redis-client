/**
 * @author kei-g <km.8k6ce+github@gmail.com>
 *
 * @copyright 2021- kei-g. All rights reserved.
 * See LICENSE file in root directory for full license.
 *
 * @module redis-client
 */

/**
 * Import Node.js modules.
 */
import { join as joinPath } from 'path'
import { readFileAsync, writeFileAsync } from 'libfsasync'

/**
 * Import local modules.
 */
import { exitIfError } from '.'

/**
 * Removes comments from the specified string.
 *
 * @param {string} input
 *
 * An input string.
 *
 * @returns {string}
 *
 * The string whose comments have been removed.
 */
const removeComments = (input: string): string => {
  let text = replaceAll(input, '\\:\\/\\/', 3, '\x1b')
  for (; ;) {
    const found = text.search('/\\*')
    if (found < 0) {
      const found = text.search('//')
      if (found < 0)
        break
      const end = text.substring(found + 2).search('\n')
      const lhs = text.substring(0, found)
      if (end < 0) {
        text = lhs
        break
      }
      const rhs = text.substring(found + end + 3)
      text = rhs.length ? lhs.concat(rhs) : lhs
      continue
    }
    const end = text.substring(found + 2).search('\\*/')
    const lhs = text.substring(0, found)
    if (end < 0) {
      text = lhs
      break
    }
    const rhs = text.substring(found + end + 4)
    text = rhs.length ? lhs.concat(rhs) : lhs
  }
  return replaceAll(text, '\x1b', 1, '://')
}

/**
 * Replace all instances
 * of a substring in a string,
 * using a search string.
 *
 * @param {string} input
 *
 *
 *
 * @param {string} searchValue
 *
 *
 *
 * @param {number} searchValueLength
 *
 *
 *
 * @param {string} replaceValue
 *
 *
 *
 * @returns {string}
 *
 *
 */
const replaceAll = (input: string, searchValue: string, searchValueLength: number, replaceValue: string): string => {
  for (let text = input; ;) {
    const found = text.search(searchValue)
    if (found < 0)
      return text
    const lhs = text.substring(0, found)
    const rhs = text.substring(found + searchValueLength)
    text = rhs.length ? lhs.concat(replaceValue, rhs) : lhs.concat(replaceValue)
  }
}

/**
 *
 */
type APIExtractorJSON = {
  mainEntryPointFilePath: string
}

(async (path: string): Promise<void> => {
  const buf = await readFileAsync(path)
  exitIfError<Buffer>(buf)
  const json = removeComments(buf.toString())
  const config = JSON.parse(json) as APIExtractorJSON
  config.mainEntryPointFilePath = 'index.d.ts'
  const written = await writeFileAsync(path, JSON.stringify(config, undefined, ' '.repeat(2)))
  exitIfError<true>(written)
  process.exit(0)
})(joinPath(process.cwd(), 'api-extractor.json'))
