<?php
/** zeropg auto-login Adminer (mount over /var/www/html/index.php of adminer:5).
 *
 * A link like
 *   http://127.0.0.1:8086/?pgsql=host.docker.internal:5499&username=postgres&db=postgres
 * lands INSIDE the database with zero typing:
 *  - Adminer prefills server/username/db from the URL,
 *  - credentials() supplies the password server-side (the zeropg wire does not
 *    verify passwords - trust is the loopback/port binding),
 *  - loginForm() auto-submits the prefilled form.
 * Optional hardening: set ZEROPG_LINK_TOKEN and append &zpt=<token> to links.
 */
function adminer_object() {
  class ZeropgAdminer extends Adminer\Adminer {
    function name() {
      return 'zeropg Adminer';
    }
    function credentials() {
      $user = $_GET['username'] !== '' ? $_GET['username'] : 'postgres';
      $pass = getenv('ZEROPG_WIRE_PASSWORD') !== false ? getenv('ZEROPG_WIRE_PASSWORD') : 'postgres';
      return array(Adminer\SERVER, $user, $pass);
    }
    function login($login, $password) {
      $need = getenv('ZEROPG_LINK_TOKEN');
      if ($need !== false && $need !== '') {
        $got = isset($_COOKIE['zpt']) ? $_COOKIE['zpt'] : (isset($_GET['zpt']) ? $_GET['zpt'] : '');
        return hash_equals($need, $got);
      }
      return true;
    }
    function loginForm() {
      parent::loginForm();
      $js = '';
      if (isset($_GET['zpt'])) {
        $js .= "document.cookie = 'zpt=" . Adminer\js_escape($_GET['zpt']) . "; SameSite=Lax; path=/';\n";
      }
      // only auto-submit when the link actually names a server
      if (isset($_GET['pgsql']) && $_GET['pgsql'] !== '') {
        $js .= "var pw = qs(\"input[name='auth[password]']\");\n"
             . "if (pw) { pw.value = 'zeropg'; pw.form.submit(); }\n";
      }
      if ($js !== '') {
        echo Adminer\script($js);
      }
    }
  }
  return new ZeropgAdminer();
}
require 'adminer.php';
