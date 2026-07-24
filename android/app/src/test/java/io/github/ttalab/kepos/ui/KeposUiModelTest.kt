package io.github.ttalab.kepos.ui

import io.github.ttalab.barekit.host.PublisherSnapshot
import io.github.ttalab.barekit.host.RuntimeSnapshot
import io.github.ttalab.barekit.host.RuntimeState
import io.github.ttalab.barekit.host.ServiceSnapshot
import org.junit.Assert.assertEquals
import org.junit.Test

class KeposUiModelTest {
  @Test
  fun stoppedRuntimeOffersAnExplicitStartState() {
    val model = KeposUiModel.from(RuntimeSnapshot(RuntimeState.STOPPED))

    assertEquals(KeposDestination.STOPPED, model.destination)
  }

  @Test
  fun unconfiguredRuntimeShowsSetupInsteadOfAnEmptyServiceHome() {
    val model = KeposUiModel.from(
      RuntimeSnapshot(RuntimeState.RUNNING, configured = false),
    )

    assertEquals(KeposDestination.SETUP, model.destination)
  }

  @Test
  fun configuredRuntimeWaitsForARealPublisherRegistry() {
    val model = KeposUiModel.from(
      RuntimeSnapshot(
        RuntimeState.RUNNING,
        configured = true,
        connection = "connecting",
      ),
    )

    assertEquals(KeposDestination.CONNECTING, model.destination)
    assertEquals(emptyList<ServiceUiModel>(), model.services)
  }

  @Test
  fun serviceHomeUsesPublisherNameAndPreservesRegistryOrder() {
    val model = KeposUiModel.from(connectedSnapshot())

    assertEquals(KeposDestination.SERVICES, model.destination)
    assertEquals("kosmos", model.publisherName)
    assertEquals(listOf("forgejo", "navidrome", "ssh"), model.services.map { it.id })
  }

  @Test
  fun serviceActionsAndIconsFollowTheRealAccessSurface() {
    val services = KeposUiModel.from(connectedSnapshot()).services

    assertEquals(ServiceAction.OPEN, services[0].action)
    assertEquals(ServiceIcon.GIT, services[0].icon)
    assertEquals(ServiceAction.COPY_URL, services[1].action)
    assertEquals(ServiceIcon.MUSIC, services[1].icon)
    assertEquals(ServiceAction.INFO, services[2].action)
    assertEquals(ServiceIcon.TERMINAL, services[2].icon)
  }

  @Test
  fun unknownServicesRemainUsableWithGenericIcons() {
    val snapshot = connectedSnapshot().copy(
      services = listOf(
        ServiceSnapshot(
          id = "photos",
          name = "Photos",
          access = "http",
          url = "http://photos.localhost:17480/",
        ),
        ServiceSnapshot(id = "database", name = "Database", access = "tcp"),
      ),
    )

    val services = KeposUiModel.from(snapshot).services

    assertEquals(ServiceIcon.WEB, services[0].icon)
    assertEquals(ServiceAction.OPEN, services[0].action)
    assertEquals(ServiceIcon.PORT, services[1].icon)
    assertEquals(ServiceAction.INFO, services[1].action)
  }

  private fun connectedSnapshot() = RuntimeSnapshot(
    state = RuntimeState.RUNNING,
    configured = true,
    connection = "connected",
    publisher = PublisherSnapshot("kosmos", "ab".repeat(32)),
    services = listOf(
      ServiceSnapshot(
        id = "forgejo",
        name = "Forgejo",
        access = "http",
        url = "http://forgejo.localhost:17480/",
      ),
      ServiceSnapshot(
        id = "navidrome",
        name = "Navidrome",
        access = "http",
        url = "http://navidrome.localhost:17480/",
      ),
      ServiceSnapshot(id = "ssh", name = "SSH", access = "tcp"),
    ),
  )
}
