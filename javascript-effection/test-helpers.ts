import { afterEach, beforeEach, describe as $describe, it, before, after } from "node:test";
import { createScope, type Operation, createContext } from "effection";
import { createRequestFn, type TestRequest } from "./easyracer.ts";
import { copy } from "jsr:@std/io@0.225";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";

let [scope, destroy] = createScope();

const HttpPortContext = createContext<number | undefined>("httpPort");

export function describe(name: string, fn: () => void): void {
  let container: StartedTestContainer;
  $describe(name, () => {
    before(async () => {
      startProxy();
      container = await new GenericContainer("ghcr.io/jamesward/easyracer")
            .withExposedPorts(8080)
            .withWaitStrategy(Wait.forHttp("/", 8080))
            .withCommand(["--debug"])
            .start()
    }, { timeout: 30_000 });

    beforeEach(() => {
      [scope, destroy] = createScope();
      scope.set(HttpPortContext, container.getFirstMappedPort());
    });

    afterEach(destroy);

    fn();

    after(async () => {
      await container.stop();
    }, { timeout: 30_000 });
  });
}

type ScenarioFn = (
  request: (
    query?: string,
  ) => TestRequest,
) => Operation<void>;

export function scenario(number: number, fn: ScenarioFn): void {
  it(`scenario ${number}`, runScenario(number, fn));
}

scenario.only = (number: number, fn: ScenarioFn) => {
  it.only(`scenario ${number}`, runScenario(number, fn));
};

scenario.skip = (number: string, _op: ScenarioFn) => {
  it.skip(`scenario ${number}`, () => {});
};

function runScenario(number: number, fn: ScenarioFn) {
  return () =>
    scope.run(function* () {
      const httpPort = yield* HttpPortContext.expect();
      let base = `http://localhost:${httpPort}`;
      let scenario = fn(createRequestFn(base, number));
      yield* scenario;
    });
}

export async function startProxy(port: number = 2375) {
  const tcpListener = Deno.listen({ port });
  Deno.env.set("DOCKER_HOST", `tcp://localhost:${port}`);

  for await (const tcpConn of tcpListener) {
    handleConnection(tcpConn);
  }

  return tcpListener;
}

async function handleConnection(tcpConn: Deno.Conn) {
  let unixConn: Deno.Conn | undefined;

  try {
    unixConn = await Deno.connect({
      transport: "unix",
      path: "/var/run/docker.sock",
    });

    const copyPromises = [
      copy(tcpConn, unixConn).catch((err) => {
        if (err.code !== "EPIPE") {
          console.error("TCP -> Unix error:", err);
        }
      }),
      copy(unixConn, tcpConn).catch((err) => {
        if (err.code !== "EPIPE") {
          console.error("Unix -> TCP error:", err);
        }
      }),
    ];

    // Wait for either copy operation to complete or fail
    await Promise.all(copyPromises).finally(() => {
      // Ensure both connections are properly closed
      try {
        unixConn?.close();
        tcpConn.close();
      } catch (closeErr) {
        console.error("Error during connection cleanup:", closeErr);
      }
    });
  } catch (error) {
    console.error("Connection error:", error);
  } finally {
    // Extra safety: ensure connections are closed even if something goes wrong above
    try {
      unixConn?.close();
      tcpConn.close();
    } catch {
      // Ignore errors during emergency cleanup
    }
  }
}

