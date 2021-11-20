/**
 * @author kei-g <km.8k6ce+github@gmail.com>
 *
 * @copyright 2021- kei-g. All rights reserved.
 * See LICENSE file in root directory for full license.
 *
 * @module redis-client
 */

/**
 * Ensures the value not to be an instance of `Error`.
 *
 * @param {Error | T} value
 *
 * A value to be ensured.
 *
 * @returns {value is T}
 *
 * True if `value` is not an instance of `Error`.
 * Otherwise, the program exits immediately with code `1`,
 * so that this function will `never` return.
 */
export const exitIfError = <T>(value: Error | T): value is T => value instanceof Error ? (console.error(value.message), process.exit(1)) : true
