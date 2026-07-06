<?php
/** zeropg auto-login for Adminer 5 (official docker image plugin format).
 *
 * Makes a link like
 *   http://127.0.0.1:8081/?pgsql=host.docker.internal:5499&username=postgres&db=postgres
 * land INSIDE the database with no typing: Adminer prefills server/username/db
 * from the URL; this plugin fills the password server-side (the zeropg wire
 * does not verify it - trust is loopback binding) and auto-submits the login
 * form. Optional: set ZEROPG_LINK_TOKEN to require &zpt=<token> on the link.
 */
class ZeropgAutologin extends Adminer\Plugin {
  function credentials() {
    // server/username come from the URL; password is fleet-known, never typed
    return array(Adminer\SERVER, $_GET["username"] ?? "postgres", getenv("ZEROPG_WIRE_PASSWORD") ?: "postgres");
  }
  function login($login, $password) {
    $need = getenv("ZEROPG_LINK_TOKEN");
    if ($need && !hash_equals($need, $_COOKIE["zpt"] ?? ($_GET["zpt"] ?? ""))) return false;
    return true;
  }
  function loginFormField($name, $heading, $value) {
    // hide the password box (it is ignored anyway) - cosmetic only
    if ($name == "password") return $heading . "<input type='password' name='auth[password]' value='zeropg' autocomplete='new-password' style='display:none'>\n";
    return null;
  }
  function loginForm() {
    // token survives the POST via cookie; then submit the prefilled form
    if (isset($_GET["zpt"])) echo Adminer\script("document.cookie = 'zpt=" . Adminer\js_escape($_GET["zpt"]) . "; SameSite=Lax';");
    if (isset($_GET["pgsql"]) || isset($_GET["server"])) echo Adminer\script("document.forms[0].submit();");
    return null;
  }
}
return new ZeropgAutologin();
