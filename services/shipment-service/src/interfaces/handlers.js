export function shipmentHandlers(application) {
  return { GetShipment: (request, actor) => application.get(request, actor), UpdateShipmentStatus: (request, actor) => application.update(request, actor), GetShipmentsByOrder: (request, actor) => application.byOrder(request, actor) };
}
