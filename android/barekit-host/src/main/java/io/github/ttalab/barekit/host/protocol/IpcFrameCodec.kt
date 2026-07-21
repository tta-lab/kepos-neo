package io.github.ttalab.barekit.host.protocol

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

class IpcFrameCodec {
  private var buffered = ByteArray(0)

  fun encode(envelope: HostEnvelope): ByteArray {
    val payload = encodeEnvelope(envelope).encodeToByteArray()
    require(payload.isNotEmpty() && payload.size <= MAX_CONTROL_FRAME_BYTES) {
      "control frame payload is outside the allowed size"
    }
    return ByteBuffer.allocate(4 + payload.size)
      .putInt(payload.size)
      .put(payload)
      .array()
  }

  fun push(chunk: ByteArray): List<HostEnvelope> {
    buffered += chunk
    val envelopes = mutableListOf<HostEnvelope>()
    var offset = 0
    while (buffered.size - offset >= 4) {
      val length = ByteBuffer.wrap(buffered, offset, 4).int
      require(length in 1..MAX_CONTROL_FRAME_BYTES) {
        "control frame length is outside the allowed size"
      }
      if (buffered.size - offset - 4 < length) break
      val payload = buffered.copyOfRange(offset + 4, offset + 4 + length)
      val encoded = try {
        StandardCharsets.UTF_8.newDecoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT)
          .decode(ByteBuffer.wrap(payload))
          .toString()
      } catch (error: Exception) {
        throw IllegalArgumentException(
          "control frame payload is not valid UTF-8 JSON",
          error,
        )
      }
      envelopes += decodeEnvelope(encoded)
      offset += 4 + length
    }
    buffered = buffered.copyOfRange(offset, buffered.size)
    return envelopes
  }
}
