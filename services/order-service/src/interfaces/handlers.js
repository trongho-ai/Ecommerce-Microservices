export function orderHandlers(application) {
  return { CreateOrder: (request, actor) => application.create(request, actor), GetOrder: (request, actor) => application.get(request, actor), ListOrders: (request, actor) => application.list(request, actor) };
}
