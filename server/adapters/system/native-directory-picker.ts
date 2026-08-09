import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DirectoryPicker } from '../../ports/directory-picker'

const execFileAsync = promisify(execFile)

export class NativeDirectoryPicker implements DirectoryPicker {
  async pickDirectory(): Promise<string | null> {
    if (process.platform !== 'darwin') throw new Error('当前系统暂不支持打开本地目录选择器。')
    const { stdout } = await execFileAsync('osascript', ['-e', [
      'try',
      'POSIX path of (choose folder with prompt "选择任务工作目录")',
      'on error number -128',
      'return ""',
      'end try',
    ].join('\n')], { shell: false })
    const directory = stdout.trim()
    return directory || null
  }
}
