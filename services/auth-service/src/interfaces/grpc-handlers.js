export function authHandlers(application) {
  return {
    Register: input => application.register(input),
    Login: input => application.login(input),
    VerifyToken: input => application.verifyToken(input),
  };
}
