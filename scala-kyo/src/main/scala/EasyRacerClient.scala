import com.sun.management.OperatingSystemMXBean
import kyo.*
import sttp.client3.*
import sttp.model.Uri.QuerySegment
import sttp.model.{ResponseMetadata, Uri}

import scala.collection.immutable.SortedMap

import java.lang.management.ManagementFactory
import java.security.MessageDigest


object EasyRacerClient extends KyoApp:

  def scenario1(scenarioUrl: Int => Uri) =
    val url = scenarioUrl(1)
    val req = Requests(_.get(url))
    Async.race(req, req)

  def scenario2(scenarioUrl: Int => Uri) =
    val url = scenarioUrl(2)
    val req = Requests(_.get(url))
    Async.race(req, req)

  def scenario3(scenarioUrl: Int => Uri) =
    val url = scenarioUrl(3)
    val reqs = Seq.fill(10000):
      Requests(_.get(url))
    Async.race(reqs)

  def scenario4(scenarioUrl: Int => Uri) =
    val url = scenarioUrl(4)
    val req = Requests(_.get(url))
    val reqWithTimeout = Async.timeout(1.seconds)(req)
    Async.race(req, reqWithTimeout)

  def scenario5(scenarioUrl: Int => Uri) =
    val url = scenarioUrl(5)
    val req = Requests(_.get(url))
    Async.race(req, req)

  def scenario6(scenarioUrl: Int => Uri) =
    val url = scenarioUrl(6)
    val req = Requests(_.get(url))
    Async.race(req, req, req)

  def scenario7(scenarioUrl: Int => Uri) =
    val url = scenarioUrl(7)
    val req = Requests(_.get(url))
    val delayedReq = Async.delay(4.seconds)(req)
    Async.race(req, delayedReq)

  def scenario8(scenarioUrl: Int => Uri) =
    def req(uri: Uri) = Requests(_.get(uri))

    case class MyResource(id: String):
      def close: Unit < Async =
        Abort.run(req(uri"${scenarioUrl(8)}?close=$id")).unit

    val myResource = defer:
      val id = await:
        req(uri"${scenarioUrl(8)}?open")
      await:
        Resource.acquireRelease(MyResource(id))(_.close)

    val reqRes = Resource.run:
      defer:
        val resource = await(myResource)
        await:
          req(uri"${scenarioUrl(8)}?use=${resource.id}")

    Async.race(reqRes, reqRes)

  // todo: maybe some kind of queue instead to avoid the instant
  def scenario9(scenarioUrl: Int => Uri) =
    val url = scenarioUrl(9)

    val req =
      Abort.run:
        defer:
          val body = await(Requests(_.get(url)))
          val now = await(Clock.now)
          now -> body

    val reqs = Seq.fill(10)(req)

    defer:
      val successes = SortedMap.from:
        await(Async.parallel(10)(reqs)).map(_.toMaybe).flatten

      successes.values.mkString

  def scenario10(scenarioUrl: Int => Uri) =
    // always puts the body into the response, even if it is empty, and includes the responseMetadata
    def req(uriModifier: Uri => Uri): (String, ResponseMetadata) < (Abort[FailedRequest] & Async) =
      val uri = uriModifier(scenarioUrl(10))
      Requests:
        _.get(uri).response:
          asString.mapWithMetadata: (stringEither, responseMetadata) =>
            Right(stringEither.fold(identity, identity) -> responseMetadata)

    val messageDigest = MessageDigest.getInstance("SHA-512")

    // recursive digesting
    def blocking(bytesEffect: Seq[Byte] < (Abort[FailedRequest] & Async)): Seq[Byte] < (Abort[FailedRequest] & Async) =
      IO:
        bytesEffect.map: bytes =>
          blocking(messageDigest.digest(bytes.toArray).toSeq)

    // runs blocking code while the request is open
    def blocker(id: String): String < (Abort[FailedRequest] & Async) =
      Async.race(
        req(_.addQuerySegment(QuerySegment.Plain(id))).map { (body, _) => body },
        blocking(Random.nextBytes(512)).map(_ => ""),
      )

    // sends CPU usage every second until the server says to stop
    def reporter(id: String): String < (Abort[FailedRequest] & Async) =
      val osBean = ManagementFactory.getPlatformMXBean(classOf[OperatingSystemMXBean])
      val load = osBean.getProcessCpuLoad * osBean.getAvailableProcessors

      defer:
        val (maybeResponseBody, responseMetadata) =
          await(req(_.addQuerySegment(QuerySegment.KeyValue(id, load.toString))))

        if responseMetadata.isRedirect then
          await(Async.delay(1.seconds)(reporter(id)))
        else if responseMetadata.isSuccess then
          maybeResponseBody
        else
          await(Abort.fail(FailedRequest(maybeResponseBody)))

    defer:
      val id = await(Random.nextStringAlphanumeric(8))
      val (_, result) = await(Async.parallel(blocker(id), reporter(id)))
      result

  def scenario11(scenarioUrl: Int => Uri) =
    val url = scenarioUrl(11)
    val req = Requests(_.get(url))
    Async.race(Async.race(req, req), req)

  def scenarioUrl(scenario: Int) = uri"http://localhost:8080/$scenario"

  def scenarios = Seq(scenario1, scenario2, scenario3, scenario4, scenario5, scenario6, scenario7, scenario8, scenario9, scenario10, scenario11)
//  def scenarios = Seq(scenario11)

  run:
    Kyo.collect(scenarios.map(s => s(scenarioUrl)))
