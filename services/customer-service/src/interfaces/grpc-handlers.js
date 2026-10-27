export function customerHandlers(application) {
  return {
    GetCustomer: (input, actor) => application.get(input, actor),
    GetMembership: (input, actor) => application.membership(input, actor),
    UpdateCustomer: (input, actor) => application.update(input, actor),
    EnsureCustomer: (input, actor) => application.ensure(input, actor),
  };
}
