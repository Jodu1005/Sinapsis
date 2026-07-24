import { describe, expect, it } from 'vitest'
import { NodeProcessRunner } from './process-runner'

describe('NodeProcessRunner', () => {
  it('does not inherit host Git, SSH, or CI credentials while retaining explicit Agent profile variables', async () => {
    const hostEnvironment = {
      GH_TOKEN: 'host-gh-token',
      GIT_ASKPASS: '/tmp/host-askpass',
      GIT_CONFIG_GLOBAL: '/Users/operator/.gitconfig',
      GIT_SSH_COMMAND: 'ssh -i /Users/operator/.ssh/id_ed25519',
      SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd/ssh-agent.sock',
      SSH_ASKPASS: '/tmp/ssh-askpass',
      CI_JOB_TOKEN: 'host-ci-token',
      GITLAB_TOKEN: 'host-gitlab-token',
    }
    const previous = Object.fromEntries(Object.keys(hostEnvironment).map((key) => [key, process.env[key]]))
    Object.assign(process.env, hostEnvironment)

    try {
      const environment = await captureChildEnvironment(new NodeProcessRunner())

      expect(environment).toMatchObject({
        OPENAI_API_KEY: 'agent-api-key',
        GITHUB_TOKEN: 'agent-provided-token',
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '',
        GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
        GCM_INTERACTIVE: 'Never',
      })
      expect(environment).not.toHaveProperty('GH_TOKEN')
      expect(environment).not.toHaveProperty('GIT_ASKPASS')
      expect(environment).not.toHaveProperty('SSH_AUTH_SOCK')
      expect(environment).not.toHaveProperty('SSH_ASKPASS')
      expect(environment).not.toHaveProperty('CI_JOB_TOKEN')
      expect(environment).not.toHaveProperty('GITLAB_TOKEN')
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

function captureChildEnvironment(runner: NodeProcessRunner): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const child = runner.spawn({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      cwd: process.cwd(),
      env: { OPENAI_API_KEY: 'agent-api-key', GITHUB_TOKEN: 'agent-provided-token' },
    })
    let stdout = ''
    child.onStdout((chunk) => { stdout += chunk })
    child.onError(reject)
    child.onExit(({ code }) => {
      if (code === 0) resolve(JSON.parse(stdout) as Record<string, string>)
      else reject(new Error(`Child process exited with ${code}.`))
    })
  })
}
