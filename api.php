<?php
// MRC Pool Ratings — tiny JSON store.
// GET  -> whole ladder (players, matches, settings) + whether an admin PIN exists.
// POST -> one change, JSON body {action, pin, ...}. Every change needs the admin PIN,
//         except "setPin" the very first time (when no PIN exists yet).
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$dir = __DIR__ . '/data';
$file = $dir . '/ladder.json';
$pinFile = $dir . '/pin.json';
if (!is_dir($dir)) { mkdir($dir, 0755, true); }
if (!file_exists($dir . '/.htaccess')) { file_put_contents($dir . '/.htaccess', "Require all denied\n"); }

function out($code, $data) { http_response_code($code); echo json_encode($data); exit; }
function blank() { return ['players' => [], 'matches' => [], 'settings' => ['kMode' => 'shared'], 'rev' => 0]; }
function newId() { return bin2hex(random_bytes(8)); }
function cleanName($s) { return trim(preg_replace('/\s+/u', ' ', mb_substr((string)$s, 0, 60))); }
function cleanDate($s) { return preg_match('/^\d{4}-\d{2}-\d{2}$/', (string)$s) ? $s : date('Y-m-d'); }

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  $data = file_exists($file) ? json_decode(file_get_contents($file), true) : blank();
  $data['hasPin'] = file_exists($pinFile);
  out(200, $data);
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') { out(405, ['error' => 'Method not allowed']); }

$req = json_decode(file_get_contents('php://input'), true);
if (!is_array($req) || empty($req['action'])) { out(400, ['error' => 'Bad request']); }
$action = $req['action'];
$pin = (string)($req['pin'] ?? '');

// PIN handling
if ($action === 'setPin') {
  if (file_exists($pinFile)) { out(403, ['error' => 'A PIN is already set.']); }
  if (!preg_match('/^\d{4,12}$/', $pin)) { out(400, ['error' => 'Use 4 to 12 digits.']); }
  file_put_contents($pinFile, json_encode(['hash' => password_hash($pin, PASSWORD_DEFAULT)]), LOCK_EX);
  out(200, ['ok' => true]);
}
if (!file_exists($pinFile)) { out(403, ['error' => 'Set an admin PIN first.']); }
usleep(150000); // slow down guessing
$stored = json_decode(file_get_contents($pinFile), true);
if (!password_verify($pin, $stored['hash'] ?? '')) { out(401, ['error' => 'Wrong PIN.']); }
if ($action === 'checkPin') { out(200, ['ok' => true]); }

// Locked read-modify-write
$fh = fopen($file, 'c+');
flock($fh, LOCK_EX);
$raw = stream_get_contents($fh);
$data = $raw ? json_decode($raw, true) : blank();
if (!is_array($data)) { $data = blank(); }

$findPlayer = function ($id) use (&$data) { foreach ($data['players'] as $i => $p) { if ($p['id'] === $id) return $i; } return -1; };
$nameTaken = function ($name, $exceptId = null) use (&$data) {
  foreach ($data['players'] as $p) { if ($p['id'] !== $exceptId && mb_strtolower($p['name']) === mb_strtolower($name)) return true; } return false;
};
$err = null; $result = ['ok' => true];

switch ($action) {
  case 'addPlayer':
    $name = cleanName($req['name'] ?? '');
    if ($name === '') { $err = 'Enter a name.'; break; }
    if ($nameTaken($name)) { $err = 'That player is already on the list.'; break; }
    $p = ['id' => newId(), 'name' => $name, 'active' => true, 'createdAt' => round(microtime(true) * 1000)];
    if (isset($req['seedRating']) && is_numeric($req['seedRating'])) { $p['seedRating'] = round(max(250, min(3000, (float)$req['seedRating'])), 1); }
    if (!empty($req['seedMatches'])) { $p['seedMatches'] = max(0, min(10000, (int)$req['seedMatches'])); }
    if (!empty($req['seedWins'])) { $p['seedWins'] = max(0, min($p['seedMatches'] ?? 0, (int)$req['seedWins'])); }
    $data['players'][] = $p; $result['id'] = $p['id'];
    break;
  case 'updatePlayer':
    $i = $findPlayer($req['id'] ?? '');
    if ($i < 0) { $err = 'Player not found.'; break; }
    if (isset($req['name'])) {
      $name = cleanName($req['name']);
      if ($name === '' || $nameTaken($name, $req['id'])) { $err = 'That name is empty or already used.'; break; }
      $data['players'][$i]['name'] = $name;
    }
    if (isset($req['active'])) { $data['players'][$i]['active'] = (bool)$req['active']; }
    break;
  case 'removePlayer':
    $id = $req['id'] ?? '';
    foreach ($data['matches'] as $m) { if ($m['winnerId'] === $id || $m['loserId'] === $id) { $err = 'This player has results, so make them inactive instead.'; break 2; } }
    $data['players'] = array_values(array_filter($data['players'], fn($p) => $p['id'] !== $id));
    break;
  case 'addMatches': // [{winnerId, loserId, date}] or names via {winner, loser, date, create}
    $list = $req['matches'] ?? [];
    if (!is_array($list) || !count($list) || count($list) > 2000) { $err = 'No results to add.'; break; }
    $base = round(microtime(true) * 1000); $added = 0;
    foreach ($list as $k => $m) {
      $w = $m['winnerId'] ?? ''; $l = $m['loserId'] ?? '';
      if ($findPlayer($w) < 0 || $findPlayer($l) < 0 || $w === $l) { $err = 'Line ' . ($k + 1) . ': unknown or identical players.'; break 2; }
      $data['matches'][] = ['id' => newId(), 'winnerId' => $w, 'loserId' => $l, 'date' => cleanDate($m['date'] ?? ''), 'createdAt' => $base + $k, 'rated' => true, 'type' => 'league'];
      $added++;
    }
    $result['added'] = $added;
    break;
  case 'deleteMatch':
    $id = $req['id'] ?? '';
    $data['matches'] = array_values(array_filter($data['matches'], fn($m) => $m['id'] !== $id));
    break;
  case 'setSettings':
    $data['settings']['kMode'] = ($req['kMode'] ?? '') === 'individual' ? 'individual' : 'shared';
    break;
  default:
    $err = 'Unknown action.';
}

if ($err === null) {
  $data['rev'] = ($data['rev'] ?? 0) + 1;
  ftruncate($fh, 0); rewind($fh);
  fwrite($fh, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
  fflush($fh);
  // keep a rolling daily backup
  @copy($file, $dir . '/backup-' . date('Y-m-d') . '.json');
}
flock($fh, LOCK_UN); fclose($fh);
if ($err !== null) { out(400, ['error' => $err]); }
$data['hasPin'] = true; $result['data'] = $data;
out(200, $result);
