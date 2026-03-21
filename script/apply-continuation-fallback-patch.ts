#!/usr/bin/env bun
import path from "node:path"

const root = process.cwd()
const injectionPath = path.join(root, "src/hooks/todo-continuation-enforcer/continuation-injection.ts")
const testPath = path.join(root, "src/hooks/todo-continuation-enforcer/todo-continuation-enforcer.test.ts")

const retryFunction = [
  "function shouldRetryWithPrompt(error: unknown): boolean {",
  "  if (!error) return false",
  "  const message = String(error).toLowerCase()",
  "  return (",
  '    message.includes("timeout") ||',
  '    message.includes("timed out") ||',
  '    message.includes("524") ||',
  '    message.includes("send failed")',
  "  )",
  "}",
].join("\n")

const fallbackCall = [
  "    const promptBody = {",
  "      path: { id: sessionID },",
  "      body: {",
  "        agent: agentName,",
  "        ...(model !== undefined ? { model } : {}),",
  "        ...(inheritedTools ? { tools: inheritedTools } : {}),",
  "        parts: [createInternalAgentTextPart(prompt)],",
  "      },",
  "      query: { directory: ctx.directory },",
  "    }",
  "",
  '    if (typeof ctx.client.session.promptAsync === "function") {',
  "      try {",
  "        await ctx.client.session.promptAsync(promptBody)",
  "      } catch (error) {",
  "        if (!shouldRetryWithPrompt(error)) {",
  "          throw error",
  "        }",
  "        log(`[${HOOK_NAME}] promptAsync failed, retrying with prompt`, {",
  "          sessionID,",
  "          error: String(error),",
  "        })",
  "        await ctx.client.session.prompt(promptBody)",
  "      }",
  "    } else {",
  "      await ctx.client.session.prompt(promptBody)",
  "    }",
].join("\n")

const fallbackTests = [
  '  test("should fallback to prompt when promptAsync fails with timeout-like error", async () => {',
  "    // given - session where promptAsync fails transiently",
  '    const sessionID = "main-prompt-fallback-timeout"',
  "    setMainSession(sessionID)",
  "    const mockInput = createMockPluginInput()",
  "    let asyncCallCount = 0",
  "    mockInput.client.session.promptAsync = async (opts: PromptRequestOptions) => {",
  "      asyncCallCount += 1",
  "      promptCalls.push({",
  "        sessionID: opts.path.id,",
  "        agent: opts.body.agent,",
  "        model: opts.body.model,",
  "        text: opts.body.parts[0].text,",
  "      })",
  '      throw new Error("Send failed: upstream timeout (524)")',
  "    }",
  "",
  "    const hook = createTodoContinuationEnforcer(mockInput, {})",
  "",
  "    // when - session goes idle",
  "    await hook.handler({",
  '      event: { type: "session.idle", properties: { sessionID } },',
  "    })",
  "    await fakeTimers.advanceBy(2500, true)",
  "",
  "    // then - fallback prompt succeeded after promptAsync failure",
  "    expect(asyncCallCount).toBe(1)",
  "    expect(promptCalls).toHaveLength(2)",
  "  })",
  "",
  '  test("should not fallback to prompt on non-transient promptAsync error", async () => {',
  "    // given - session where promptAsync fails with non-retriable error",
  '    const sessionID = "main-prompt-no-fallback"',
  "    setMainSession(sessionID)",
  "    const mockInput = createMockPluginInput()",
  "    let asyncCallCount = 0",
  "    let promptCallCount = 0",
  "",
  "    mockInput.client.session.prompt = async (opts: PromptRequestOptions) => {",
  "      promptCallCount += 1",
  "      promptCalls.push({",
  "        sessionID: opts.path.id,",
  "        agent: opts.body.agent,",
  "        model: opts.body.model,",
  "        text: opts.body.parts[0].text,",
  "      })",
  "      return {}",
  "    }",
  "",
  "    mockInput.client.session.promptAsync = async (opts: PromptRequestOptions) => {",
  "      asyncCallCount += 1",
  "      promptCalls.push({",
  "        sessionID: opts.path.id,",
  "        agent: opts.body.agent,",
  "        model: opts.body.model,",
  "        text: opts.body.parts[0].text,",
  "      })",
  '      throw new Error("simulated auth failure")',
  "    }",
  "",
  "    const hook = createTodoContinuationEnforcer(mockInput, {})",
  "",
  "    // when - session goes idle",
  "    await hook.handler({",
  '      event: { type: "session.idle", properties: { sessionID } },',
  "    })",
  "    await fakeTimers.advanceBy(2500, true)",
  "",
  "    // then - no fallback used, failure path preserved",
  "    expect(asyncCallCount).toBe(1)",
  "    expect(promptCallCount).toBe(0)",
  "    expect(promptCalls).toHaveLength(1)",
  "  })",
].join("\n")

function patchInjection(content: string) {
  const eol = content.includes("\r\n") ? "\r\n" : "\n"
  let text = content.replace(/\r\n/g, "\n")
  let changed = false

  if (!text.includes("function shouldRetryWithPrompt(error: unknown): boolean")) {
    const marker = "export async function injectContinuation(args: {"
    const markerIndex = text.indexOf(marker)
    if (markerIndex === -1) {
      throw new Error("Unable to find injectContinuation declaration in continuation-injection.ts")
    }
    text = `${text.slice(0, markerIndex)}${retryFunction}\n\n${text.slice(markerIndex)}`
    changed = true
  }

  if (!text.includes("promptAsync failed, retrying with prompt")) {
    const asyncCall =
      /^\s*await\s+ctx\.client\.session\.promptAsync\(\s*\{\s*path:\s*\{\s*id:\s*sessionID\s*\},[\s\S]*?query:\s*\{\s*directory:\s*ctx\.directory\s*\},\s*\}\s*\)\s*;?\s*$/m
    if (!asyncCall.test(text)) {
      throw new Error("Unable to find promptAsync call block in continuation-injection.ts")
    }
    text = text.replace(asyncCall, fallbackCall)
    changed = true
  }

  if (!changed) {
    return { text: content, changed }
  }

  return { text: eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text, changed }
}

function patchTests(content: string) {
  const eol = content.includes("\r\n") ? "\r\n" : "\n"
  let text = content.replace(/\r\n/g, "\n")
  let changed = false

  if (!text.includes("should fallback to prompt when promptAsync fails with timeout-like error")) {
    const match = /\n\}\)\s*$/.exec(text)
    if (!match || match.index === undefined) {
      throw new Error("Unable to find describe() closing block in todo-continuation-enforcer.test.ts")
    }
    const insertIndex = match.index
    text = `${text.slice(0, insertIndex)}\n\n${fallbackTests}\n${text.slice(insertIndex)}`
    changed = true
  }

  if (!changed) {
    return { text: content, changed }
  }

  return { text: eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text, changed }
}

const injectionOriginal = await Bun.file(injectionPath).text()
const injectionPatched = patchInjection(injectionOriginal)
if (injectionPatched.changed) {
  await Bun.write(injectionPath, injectionPatched.text)
}

const testsOriginal = await Bun.file(testPath).text()
const testsPatched = patchTests(testsOriginal)
if (testsPatched.changed) {
  await Bun.write(testPath, testsPatched.text)
}

if (!injectionPatched.changed && !testsPatched.changed) {
  console.log("Patch already applied; no changes needed")
  process.exit(0)
}

const changed = [injectionPatched.changed ? injectionPath : null, testsPatched.changed ? testPath : null].filter(
  (value): value is string => Boolean(value),
)

console.log(`Patched ${changed.length} file(s):`)
for (const file of changed) {
  console.log(`- ${path.relative(root, file)}`)
}
