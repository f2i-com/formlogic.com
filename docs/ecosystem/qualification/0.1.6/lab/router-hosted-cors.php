<?php
/**
 * Lab router for the browser round-trip lane. The static headers the hosted app
 * frame and the embedded editors need now live in formlogic/ci/router.php
 * itself (so CI's golden paths can render a hosted app too); this file only
 * keeps the lab's documented command working:
 *
 *   php -d variables_order=EGPCS -S 127.0.0.1:18090 -t formlogic/ui/dist docs/ecosystem/qualification/0.1.6/lab/router-hosted-cors.php
 */
return require __DIR__ . '/../../../../../formlogic/ci/router.php';
