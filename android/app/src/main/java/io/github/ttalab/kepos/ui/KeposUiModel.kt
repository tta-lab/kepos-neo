package io.github.ttalab.kepos.ui

import io.github.ttalab.barekit.host.RuntimeSnapshot
import io.github.ttalab.barekit.host.RuntimeState
import io.github.ttalab.barekit.host.ServiceSnapshot

enum class KeposDestination {
  SETUP,
  STOPPED,
  CONNECTING,
  SERVICES,
  FAILED,
}

enum class ServiceAction {
  OPEN,
  COPY_URL,
  COPY_ADDRESS,
  INFO,
}

enum class ServiceIcon {
  MUSIC,
  TERMINAL,
  GIT,
  BUILD,
  WEB,
  PORT,
}

data class ServiceUiModel(
  val id: String,
  val name: String,
  val access: String,
  val url: String?,
  val action: ServiceAction,
  val icon: ServiceIcon,
)

data class KeposUiModel(
  val destination: KeposDestination,
  val publisherName: String? = null,
  val connection: String? = null,
  val services: List<ServiceUiModel> = emptyList(),
  val available: Boolean = false,
  val error: String? = null,
) {
  companion object {
    fun from(snapshot: RuntimeSnapshot): KeposUiModel {
      if (snapshot.state == RuntimeState.STOPPED) {
        return KeposUiModel(destination = KeposDestination.STOPPED)
      }
      if (snapshot.state == RuntimeState.FAILED) {
        return KeposUiModel(
          destination = KeposDestination.FAILED,
          error = snapshot.error,
        )
      }
      if (snapshot.state != RuntimeState.RUNNING) {
        return KeposUiModel(destination = KeposDestination.CONNECTING)
      }
      if (!snapshot.configured) {
        return KeposUiModel(destination = KeposDestination.SETUP)
      }
      val publisher = snapshot.publisher
        ?: return KeposUiModel(
          destination = KeposDestination.CONNECTING,
          connection = snapshot.connection,
        )
      return KeposUiModel(
        destination = KeposDestination.SERVICES,
        publisherName = publisher.displayName,
        connection = snapshot.connection,
        services = snapshot.services.map(::serviceUiModel),
        available = snapshot.connection == "connected",
      )
    }

    private fun serviceUiModel(service: ServiceSnapshot): ServiceUiModel {
      val action = when {
        service.id == "navidrome" && service.url != null -> ServiceAction.COPY_URL
        service.access == "http" && service.url != null -> ServiceAction.OPEN
        service.url != null -> ServiceAction.COPY_ADDRESS
        else -> ServiceAction.INFO
      }
      val icon = when (service.id) {
        "navidrome" -> ServiceIcon.MUSIC
        "ssh" -> ServiceIcon.TERMINAL
        "forgejo" -> ServiceIcon.GIT
        "woodpecker" -> ServiceIcon.BUILD
        else -> if (service.access == "http") ServiceIcon.WEB else ServiceIcon.PORT
      }
      return ServiceUiModel(
        id = service.id,
        name = service.name,
        access = service.access,
        url = service.url,
        action = action,
        icon = icon,
      )
    }
  }
}
