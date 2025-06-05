import { createContext, createScope, type Operation } from "effection";
import { copy } from "jsr:@std/io@0.225";
import { describe as $describe, after, afterEach, before, beforeEach, it } from "node:test";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { createRequestFn, type TestRequest } from "./easyracer.ts";

let [scope, destroy] = createScope();

const HttpPortContext = createContext<number | undefined>("httpPort");
const connections: Deno.Conn[] = [];

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
      connections.forEach((tcpConn) => {
        tcpConn.close();
      });
      connections.length = 0;
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
    connections.push(...(await handleConnection(tcpConn)));
  }

  return tcpListener;
}

async function handleConnection(tcpConn: Deno.Conn) {
  let unixConn: Deno.Conn | undefined;

  unixConn = await Deno.connect({
    transport: "unix",
    path: "/var/run/docker.sock",
  });

  copy(tcpConn, unixConn).catch(() => {});

  copy(unixConn, tcpConn).catch(() => {});


  return [tcpConn, unixConn];
}

