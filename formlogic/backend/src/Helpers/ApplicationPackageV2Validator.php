<?php

declare(strict_types=1);

namespace FormLogic\Helpers;

/**
 * Application Package v2 + Flow Node Definition v1 — the PHP validation gate
 * (ADR-010; docs/contracts/application-package.v2.schema.json,
 * docs/contracts/flow-node-definition.v1.schema.json).
 *
 * The TypeScript twin is ui/src/application-package/packageV2.ts; both are pinned
 * against docs/contracts/fixtures/application-package-v2-cases.json with IDENTICAL
 * error codes, so the languages cannot drift on what is valid. Contract rules
 * (ADR-010): unknown fields fail closed everywhere (exception: uiHints entries are
 * presentation-only and IGNORED); the v1 handler allowlist is core-preset +
 * service-action, with known-later kinds rejected as handler_kind_not_enabled;
 * port/config schemas use the declaration subset strictly TIGHTER than the desktop
 * §6.5 runtime validator; $ref resolves only from the local allowlist.
 *
 * PHP/JSON note: after json_decode(..., true) an empty {} and an empty [] are both
 * []. Maps are therefore "array that is empty or not a list"; the shared fixture
 * corpus avoids empty-container cases where that ambiguity would matter.
 *
 * Issues are ['code' => ..., 'path' => ..., 'message' => ...]; valid = zero issues.
 */
class ApplicationPackageV2Validator
{
    private const SEMVER = '/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/';
    private const SEMVER_RANGE = '/^(\^|~|>=)?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/';
    private const NAMESPACED_ID = '/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/';
    private const NODE_TYPE = '/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*){2,}$/';
    private const SLOT = '/^[a-zA-Z][a-zA-Z0-9]{0,63}$/';
    private const ACTION_ID = '/^[a-z0-9][a-z0-9-]{0,63}$/';
    private const PORT_ID = '/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/';
    private const CORE_TYPE = '/^[a-z][a-z0-9_]{0,47}$/';
    private const ICON_ID = '/^[a-z0-9-]{1,48}$/';
    private const SHA256_HEX = '/^[a-f0-9]{64}$/';
    private const ENTRY_PATH = '/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/';

    private const PACKAGE_KINDS = ['application', 'extension', 'node-library', 'bundle'];
    private const RUNTIME_KINDS = ['managed-service', 'desktop-plugin'];
    private const HOSTS = ['desktop', 'paired-browser', 'cloud'];
    private const ARTIFACT_KINDS = ['image', 'audio', 'video', 'file'];
    private const SIDE_EFFECTS = ['none', 'read', 'external-write', 'destructive'];
    private const IDEMPOTENCY = ['none', 'caller-key'];
    private const LATER_HANDLER_KINDS = ['connector-action', 'subflow', 'quickjs', 'hosted-action'];
    private const REF_ALLOWLIST = ['formlogic://schemas/artifact-ref.json'];
    private const SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'];
    private const SCHEMA_KEYWORDS = [
        'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
        'minLength', 'maxLength', 'minimum', 'maximum',
        'title', 'description', 'default', 'examples',
        '$ref', 'x-artifactKinds',
    ];

    private const MAX_SCHEMA_DEPTH = 8;
    private const MAX_SCHEMA_PROPERTIES = 64;
    private const MAX_ENUM_ENTRIES = 64;
    private const MAX_NODE_DEF_BYTES = 262144;       // 256 KiB
    private const MAX_PACKAGE_BYTES = 20971520;      // 20 MiB
    private const MAX_HANDLER_DEFAULTS_BYTES = 32768; // 32 KiB

    /** @return list<array{code:string,path:string,message:string}> */
    public static function validatePackage(mixed $value): array
    {
        $issues = [];
        if (!self::isMap($value)) {
            return [self::issue('not_object', '$', 'an application package must be an object')];
        }
        if (strlen((string) json_encode($value)) > self::MAX_PACKAGE_BYTES) {
            return [self::issue('too_large', '$', 'package exceeds the size cap')];
        }
        self::checkUnknownKeys($value, ['formatVersion', 'package', 'dependencies', 'content', 'contributions', 'requirements', 'serviceDistributions'], '$', $issues);

        if (($value['formatVersion'] ?? null) !== 2) {
            $issues[] = self::issue('bad_format_version', '$.formatVersion', 'formatVersion must be 2');
        }

        $publisherId = null;
        $meta = $value['package'] ?? null;
        if (!self::isMap($meta)) {
            $issues[] = self::issue('bad_package_meta', '$.package', 'package metadata is required');
        } else {
            self::checkUnknownKeys($meta, ['id', 'kind', 'version', 'publisherId', 'displayName', 'description'], '$.package', $issues);
            $idOk = self::isStr($meta['id'] ?? null, 1, 128) && preg_match(self::NAMESPACED_ID, (string) $meta['id']) === 1;
            if (!$idOk) {
                $issues[] = self::issue('bad_package_id', '$.package.id', 'package id must be a namespaced id (>=2 dot-segments)');
            }
            if (!self::isStr($meta['publisherId'] ?? null, 1, 96) || preg_match(self::NAMESPACED_ID, (string) $meta['publisherId']) !== 1) {
                $issues[] = self::issue('bad_publisher_id', '$.package.publisherId', 'publisherId must be a namespaced id');
            } else {
                $publisherId = (string) $meta['publisherId'];
                if ($idOk && !str_starts_with((string) $meta['id'], $publisherId . '.')) {
                    $issues[] = self::issue('package_id_outside_publisher', '$.package.id', 'package id must extend the publisher namespace "' . $publisherId . '."');
                }
            }
            if (!self::isStr($meta['kind'] ?? null) || !in_array($meta['kind'], self::PACKAGE_KINDS, true)) {
                $issues[] = self::issue('bad_package_kind', '$.package.kind', 'kind must be application | extension | node-library | bundle');
            }
            if (!self::isStr($meta['version'] ?? null, 1, 64) || preg_match(self::SEMVER, (string) $meta['version']) !== 1) {
                $issues[] = self::issue('bad_semver', '$.package.version', 'version must be exact semver');
            }
            if (!self::isStr($meta['displayName'] ?? null, 1, 120)) {
                $issues[] = self::issue('bad_display_name', '$.package.displayName', 'displayName (1..120 chars) is required');
            }
            if (array_key_exists('description', $meta) && !self::isStr($meta['description'], 0, 2000)) {
                $issues[] = self::issue('bad_display_name', '$.package.description', 'description must be a string of at most 2000 chars');
            }
        }

        if (array_key_exists('dependencies', $value)) {
            $deps = $value['dependencies'];
            if (!self::isMap($deps)) {
                $issues[] = self::issue('bad_dependency', '$.dependencies', 'dependencies must be an object');
            } else {
                self::checkUnknownKeys($deps, ['packages', 'desktop'], '$.dependencies', $issues);
                if (array_key_exists('packages', $deps)) {
                    if (!self::isList($deps['packages'])) {
                        $issues[] = self::issue('bad_dependency', '$.dependencies.packages', 'packages must be an array');
                    } elseif (count($deps['packages']) > 32) {
                        $issues[] = self::issue('limit_exceeded', '$.dependencies.packages', 'at most 32 package dependencies');
                    } else {
                        foreach ($deps['packages'] as $i => $dep) {
                            $p = '$.dependencies.packages[' . $i . ']';
                            if (!self::isMap($dep)) {
                                $issues[] = self::issue('bad_dependency', $p, 'a dependency must be an object');
                                continue;
                            }
                            self::checkUnknownKeys($dep, ['id', 'version', 'optional', 'reason'], $p, $issues);
                            if (!self::isStr($dep['id'] ?? null, 1, 128) || preg_match(self::NAMESPACED_ID, (string) $dep['id']) !== 1) {
                                $issues[] = self::issue('bad_dependency', $p . '.id', 'dependency id must be a namespaced id');
                            }
                            if (!self::isStr($dep['version'] ?? null, 1, 64) || preg_match(self::SEMVER_RANGE, (string) $dep['version']) !== 1) {
                                $issues[] = self::issue('bad_semver_range', $p . '.version', 'dependency version must use the v1 range grammar (X.Y.Z | ^X.Y.Z | ~X.Y.Z | >=X.Y.Z)');
                            }
                            if (array_key_exists('optional', $dep) && !is_bool($dep['optional'])) {
                                $issues[] = self::issue('bad_dependency', $p . '.optional', 'optional must be a boolean');
                            }
                            if (array_key_exists('reason', $dep) && !self::isStr($dep['reason'], 0, 300)) {
                                $issues[] = self::issue('bad_dependency', $p . '.reason', 'reason must be a string of at most 300 chars');
                            }
                        }
                    }
                }
                if (array_key_exists('desktop', $deps)) {
                    $desk = $deps['desktop'];
                    if (!self::isMap($desk)) {
                        $issues[] = self::issue('bad_dependency', '$.dependencies.desktop', 'desktop must be an object');
                    } else {
                        self::checkUnknownKeys($desk, ['minimumVersion', 'features'], '$.dependencies.desktop', $issues);
                        if (array_key_exists('minimumVersion', $desk) && (!self::isStr($desk['minimumVersion']) || preg_match(self::SEMVER, (string) $desk['minimumVersion']) !== 1)) {
                            $issues[] = self::issue('bad_semver', '$.dependencies.desktop.minimumVersion', 'minimumVersion must be exact semver');
                        }
                        if (array_key_exists('features', $desk)) {
                            $feats = $desk['features'];
                            $ok = self::isList($feats) && count($feats) <= 32;
                            if ($ok) {
                                foreach ($feats as $f) {
                                    if (!self::isStr($f, 1, 128)) {
                                        $ok = false;
                                        break;
                                    }
                                }
                            }
                            if (!$ok) {
                                $issues[] = self::issue('bad_dependency', '$.dependencies.desktop.features', 'features must be at most 32 non-empty strings');
                            }
                        }
                    }
                }
            }
        }

        $hasContent = false;
        if (array_key_exists('content', $value)) {
            $content = $value['content'];
            if (!self::isMap($content)) {
                $issues[] = self::issue('bad_content_ref', '$.content', 'content must be an object');
            } else {
                self::checkUnknownKeys($content, ['pack'], '$.content', $issues);
                if (array_key_exists('pack', $content)) {
                    $pack = $content['pack'];
                    if (is_string($pack)) {
                        if (!self::isStr($pack, 1, 200) || preg_match(self::ENTRY_PATH, $pack) !== 1) {
                            $issues[] = self::issue('bad_content_ref', '$.content.pack', 'pack entry path must be a safe archive path');
                        } else {
                            $hasContent = true;
                        }
                    } elseif (self::isMap($pack)) {
                        $hasContent = true; // inline Pack v1 — validated by the Pack v1 validator, unchanged.
                    } else {
                        $issues[] = self::issue('bad_content_ref', '$.content.pack', 'pack must be an entry path or an inline Pack object');
                    }
                }
            }
        }

        // Declared requirement slots first — the contribution handler cross-check needs them.
        $declaredSlots = [];
        $hasRequirements = false;
        if (array_key_exists('requirements', $value)) {
            $req = $value['requirements'];
            if (!self::isMap($req)) {
                $issues[] = self::issue('bad_requirement', '$.requirements', 'requirements must be an object');
            } else {
                self::checkUnknownKeys($req, ['services'], '$.requirements', $issues);
                if (array_key_exists('services', $req)) {
                    if (!self::isList($req['services'])) {
                        $issues[] = self::issue('bad_requirement', '$.requirements.services', 'services must be an array');
                    } elseif (count($req['services']) > 16) {
                        $issues[] = self::issue('limit_exceeded', '$.requirements.services', 'at most 16 service requirements');
                    } else {
                        foreach ($req['services'] as $i => $svc) {
                            $p = '$.requirements.services[' . $i . ']';
                            if (!self::isMap($svc)) {
                                $issues[] = self::issue('bad_requirement', $p, 'a service requirement must be an object');
                                continue;
                            }
                            $hasRequirements = true;
                            self::checkUnknownKeys($svc, ['slot', 'required', 'requiredActions', 'constraints'], $p, $issues);
                            $slot = $svc['slot'] ?? null;
                            if (!self::isStr($slot) || preg_match(self::SLOT, (string) $slot) !== 1) {
                                $issues[] = self::issue('bad_slot', $p . '.slot', 'slot must match the slot grammar');
                            } elseif (in_array($slot, $declaredSlots, true)) {
                                $issues[] = self::issue('duplicate_slot', $p . '.slot', 'duplicate slot "' . $slot . '"');
                            } else {
                                $declaredSlots[] = $slot;
                            }
                            if (array_key_exists('required', $svc) && !is_bool($svc['required'])) {
                                $issues[] = self::issue('bad_requirement', $p . '.required', 'required must be a boolean');
                            }
                            if (array_key_exists('requiredActions', $svc)) {
                                $acts = $svc['requiredActions'];
                                $ok = self::isList($acts) && count($acts) <= 32;
                                if ($ok) {
                                    foreach ($acts as $a) {
                                        if (!self::isStr($a) || preg_match(self::ACTION_ID, (string) $a) !== 1) {
                                            $ok = false;
                                            break;
                                        }
                                    }
                                }
                                if (!$ok) {
                                    $issues[] = self::issue('bad_requirement', $p . '.requiredActions', 'requiredActions must be at most 32 action ids');
                                }
                            }
                            if (array_key_exists('constraints', $svc)) {
                                $cons = $svc['constraints'];
                                if (!self::isMap($cons)) {
                                    $issues[] = self::issue('bad_requirement', $p . '.constraints', 'constraints must be an object');
                                } else {
                                    self::checkUnknownKeys($cons, ['artifactKinds', 'availability'], $p . '.constraints', $issues);
                                    if (array_key_exists('artifactKinds', $cons) && !self::isEnumList($cons['artifactKinds'], self::ARTIFACT_KINDS, 8, false)) {
                                        $issues[] = self::issue('bad_requirement', $p . '.constraints.artifactKinds', 'artifactKinds must list supported artifact kinds');
                                    }
                                    if (array_key_exists('availability', $cons) && !self::isEnumList($cons['availability'], self::HOSTS, 3, true)) {
                                        $issues[] = self::issue('bad_availability', $p . '.constraints.availability', 'availability must be a unique subset of desktop | paired-browser | cloud');
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        $hasContributions = false;
        if (array_key_exists('contributions', $value)) {
            $contrib = $value['contributions'];
            if (!self::isMap($contrib)) {
                $issues[] = self::issue('bad_contribution', '$.contributions', 'contributions must be an object');
            } else {
                self::checkUnknownKeys($contrib, ['flowNodes'], '$.contributions', $issues);
                if (array_key_exists('flowNodes', $contrib)) {
                    if (!self::isList($contrib['flowNodes'])) {
                        $issues[] = self::issue('bad_contribution', '$.contributions.flowNodes', 'flowNodes must be an array');
                    } elseif (count($contrib['flowNodes']) > 64) {
                        $issues[] = self::issue('limit_exceeded', '$.contributions.flowNodes', 'at most 64 flow-node contributions');
                    } else {
                        $seenTypes = [];
                        foreach ($contrib['flowNodes'] as $i => $node) {
                            $p = '$.contributions.flowNodes[' . $i . ']';
                            if (is_string($node)) {
                                if (!self::isStr($node, 1, 200) || preg_match(self::ENTRY_PATH, $node) !== 1) {
                                    $issues[] = self::issue('bad_contribution', $p, 'a flow-node entry path must be a safe archive path');
                                } else {
                                    $hasContributions = true;
                                }
                            } elseif (self::isMap($node)) {
                                $hasContributions = true;
                                foreach (self::validateNodeDefinition($node, $publisherId, $declaredSlots, $p) as $nested) {
                                    $issues[] = $nested;
                                }
                                $t = $node['type'] ?? null;
                                if (self::isStr($t)) {
                                    if (in_array($t, $seenTypes, true)) {
                                        $issues[] = self::issue('duplicate_contribution', $p . '.type', 'duplicate contributed type "' . $t . '"');
                                    }
                                    $seenTypes[] = $t;
                                }
                            } else {
                                $issues[] = self::issue('bad_contribution', $p, 'a contribution must be an entry path or an inline definition');
                            }
                        }
                    }
                }
            }
        }

        $hasDistributions = false;
        if (array_key_exists('serviceDistributions', $value)) {
            $dists = $value['serviceDistributions'];
            if (!self::isList($dists)) {
                $issues[] = self::issue('bad_distribution', '$.serviceDistributions', 'serviceDistributions must be an array');
            } elseif (count($dists) > 8) {
                $issues[] = self::issue('limit_exceeded', '$.serviceDistributions', 'at most 8 service distributions');
            } else {
                foreach ($dists as $i => $dist) {
                    $p = '$.serviceDistributions[' . $i . ']';
                    if (!self::isMap($dist)) {
                        $issues[] = self::issue('bad_distribution', $p, 'a distribution must be an object');
                        continue;
                    }
                    $hasDistributions = true;
                    self::checkUnknownKeys($dist, ['id', 'runtimeKind', 'satisfiesSlots', 'optionalCandidate', 'definition', 'artifact', 'installPolicy', 'autoStart'], $p, $issues);
                    if (!self::isStr($dist['id'] ?? null, 1, 128) || preg_match(self::NAMESPACED_ID, (string) $dist['id']) !== 1) {
                        $issues[] = self::issue('bad_distribution', $p . '.id', 'distribution id must be a namespaced id');
                    }
                    if (!self::isStr($dist['runtimeKind'] ?? null) || !in_array($dist['runtimeKind'], self::RUNTIME_KINDS, true)) {
                        $issues[] = self::issue('bad_runtime_kind', $p . '.runtimeKind', 'runtimeKind must be managed-service | desktop-plugin');
                    }
                    $slots = $dist['satisfiesSlots'] ?? null;
                    $slotsOk = self::isList($slots) && count($slots) >= 1 && count($slots) <= 16;
                    if ($slotsOk) {
                        foreach ($slots as $s) {
                            if (!self::isStr($s) || preg_match(self::SLOT, (string) $s) !== 1) {
                                $slotsOk = false;
                                break;
                            }
                        }
                    }
                    if (!$slotsOk) {
                        $issues[] = self::issue('bad_distribution', $p . '.satisfiesSlots', 'satisfiesSlots must be 1..16 slot names');
                    } else {
                        foreach ($slots as $j => $s) {
                            if (!in_array($s, $declaredSlots, true)) {
                                $issues[] = self::issue('unknown_binding_slot', $p . '.satisfiesSlots[' . $j . ']', 'slot "' . $s . '" is not declared in requirements.services');
                            }
                        }
                    }
                    if (array_key_exists('optionalCandidate', $dist) && !is_bool($dist['optionalCandidate'])) {
                        $issues[] = self::issue('bad_distribution', $p . '.optionalCandidate', 'optionalCandidate must be a boolean');
                    }
                    $definition = $dist['definition'] ?? null;
                    if (is_string($definition)) {
                        if (!self::isStr($definition, 1, 200) || preg_match(self::ENTRY_PATH, $definition) !== 1) {
                            $issues[] = self::issue('bad_distribution', $p . '.definition', 'definition entry path must be a safe archive path');
                        }
                    } elseif (!self::isMap($definition)) {
                        $issues[] = self::issue('bad_distribution', $p . '.definition', 'definition must be an entry path or an inline ServiceDefinition');
                    }
                    $artifact = $dist['artifact'] ?? null;
                    if (!self::isMap($artifact)) {
                        $issues[] = self::issue('bad_distribution', $p . '.artifact', 'artifact is required');
                    } else {
                        self::checkUnknownKeys($artifact, ['artifactId', 'version', 'sha256'], $p . '.artifact', $issues);
                        if (!self::isStr($artifact['artifactId'] ?? null, 1, 128)) {
                            $issues[] = self::issue('bad_distribution', $p . '.artifact.artifactId', 'artifactId is required');
                        }
                        if (!self::isStr($artifact['version'] ?? null) || preg_match(self::SEMVER, (string) $artifact['version']) !== 1) {
                            $issues[] = self::issue('bad_semver', $p . '.artifact.version', 'artifact version must be exact semver');
                        }
                        if (!self::isStr($artifact['sha256'] ?? null) || preg_match(self::SHA256_HEX, (string) $artifact['sha256']) !== 1) {
                            $issues[] = self::issue('bad_artifact_digest', $p . '.artifact.sha256', 'sha256 must be 64 lowercase hex chars');
                        }
                    }
                    if (($dist['installPolicy'] ?? null) !== 'prompt') {
                        $issues[] = self::issue('bad_install_policy', $p . '.installPolicy', 'v1 supports only installPolicy "prompt" (native approval on the target Desktop)');
                    }
                    if (array_key_exists('autoStart', $dist) && !in_array($dist['autoStart'], ['auto', 'manual'], true)) {
                        $issues[] = self::issue('bad_distribution', $p . '.autoStart', 'autoStart must be auto | manual');
                    }
                }
            }
        }

        if (!$hasContent && !$hasContributions && !$hasRequirements && !$hasDistributions) {
            $issues[] = self::issue('empty_package', '$', 'a package must carry at least one content item, contribution, requirement, or distribution');
        }

        return array_values($issues);
    }

    /**
     * Validate a Flow Node Definition v1. $publisherId (inside an aggregate) enforces the
     * publisher-namespace rule; $declaredSlots (non-null) enforces that a service-action
     * handler references a declared requirement slot.
     *
     * @param list<string>|null $declaredSlots
     * @return list<array{code:string,path:string,message:string}>
     */
    public static function validateNodeDefinition(mixed $value, ?string $publisherId = null, ?array $declaredSlots = null, string $basePath = '$'): array
    {
        $issues = [];
        if (!self::isMap($value)) {
            return [self::issue('not_object', $basePath, 'a node definition must be an object')];
        }
        if (strlen((string) json_encode($value)) > self::MAX_NODE_DEF_BYTES) {
            return [self::issue('too_large', $basePath, 'node definition exceeds the size cap')];
        }
        self::checkUnknownKeys($value, [
            'schemaVersion', 'type', 'version', 'display', 'ports', 'configurationSchema',
            'uiHints', 'handler', 'availability', 'requiredGrants', 'sideEffects', 'idempotency', 'deprecation',
        ], $basePath, $issues);

        if (($value['schemaVersion'] ?? null) !== 1) {
            $issues[] = self::issue('bad_schema_version', $basePath . '.schemaVersion', 'schemaVersion must be 1');
        }
        $type = $value['type'] ?? null;
        if (!self::isStr($type, 1, 160) || preg_match(self::NODE_TYPE, (string) $type) !== 1) {
            $issues[] = self::issue('bad_node_type', $basePath . '.type', 'type must be a namespaced id with at least three dot-segments (core types are dot-free and cannot be shadowed)');
        } elseif ($publisherId !== null && !str_starts_with((string) $type, $publisherId . '.')) {
            $issues[] = self::issue('contribution_outside_publisher', $basePath . '.type', 'contributed type must extend the package publisher namespace "' . $publisherId . '."');
        }
        if (!self::isStr($value['version'] ?? null, 1, 64) || preg_match(self::SEMVER, (string) $value['version']) !== 1) {
            $issues[] = self::issue('bad_semver', $basePath . '.version', 'version must be exact semver');
        }

        $display = $value['display'] ?? null;
        if (!self::isMap($display) || !self::isStr($display['label'] ?? null, 1, 80)) {
            $issues[] = self::issue('bad_display', $basePath . '.display', 'display.label (1..80 chars) is required');
        } else {
            self::checkUnknownKeys($display, ['label', 'description', 'category', 'iconId'], $basePath . '.display', $issues);
            if (array_key_exists('description', $display) && !self::isStr($display['description'], 0, 500)) {
                $issues[] = self::issue('bad_display', $basePath . '.display.description', 'description must be a string of at most 500 chars');
            }
            if (array_key_exists('category', $display) && !self::isStr($display['category'], 0, 40)) {
                $issues[] = self::issue('bad_display', $basePath . '.display.category', 'category must be a string of at most 40 chars');
            }
            if (array_key_exists('iconId', $display) && (!self::isStr($display['iconId']) || preg_match(self::ICON_ID, (string) $display['iconId']) !== 1)) {
                $issues[] = self::issue('bad_display', $basePath . '.display.iconId', 'iconId must match the icon-id grammar');
            }
        }

        if (array_key_exists('ports', $value)) {
            $ports = $value['ports'];
            if (!self::isList($ports)) {
                $issues[] = self::issue('bad_port', $basePath . '.ports', 'ports must be an array');
            } elseif (count($ports) > 32) {
                $issues[] = self::issue('limit_exceeded', $basePath . '.ports', 'at most 32 ports');
            } else {
                $seen = [];
                foreach ($ports as $i => $port) {
                    $p = $basePath . '.ports[' . $i . ']';
                    if (!self::isMap($port)) {
                        $issues[] = self::issue('bad_port', $p, 'a port must be an object');
                        continue;
                    }
                    self::checkUnknownKeys($port, ['id', 'direction', 'kind', 'required', 'multiple', 'schema'], $p, $issues);
                    $pid = $port['id'] ?? null;
                    if (!self::isStr($pid) || preg_match(self::PORT_ID, (string) $pid) !== 1) {
                        $issues[] = self::issue('bad_port', $p . '.id', 'port id must match the port-id grammar');
                    } else {
                        $lower = strtolower((string) $pid);
                        if (in_array($lower, $seen, true)) {
                            $issues[] = self::issue('duplicate_port', $p . '.id', 'duplicate port id "' . $pid . '" (case-insensitive)');
                        }
                        $seen[] = $lower;
                    }
                    if (!in_array($port['direction'] ?? null, ['input', 'output'], true)) {
                        $issues[] = self::issue('bad_port', $p . '.direction', 'direction must be input or output');
                    }
                    if (!in_array($port['kind'] ?? null, ['control', 'data'], true)) {
                        $issues[] = self::issue('bad_port', $p . '.kind', 'kind must be control or data');
                    }
                    if (array_key_exists('required', $port) && !is_bool($port['required'])) {
                        $issues[] = self::issue('bad_port', $p . '.required', 'required must be a boolean');
                    }
                    if (array_key_exists('multiple', $port) && !is_bool($port['multiple'])) {
                        $issues[] = self::issue('bad_port', $p . '.multiple', 'multiple must be a boolean');
                    }
                    if (array_key_exists('schema', $port)) {
                        if (($port['kind'] ?? null) !== 'data') {
                            $issues[] = self::issue('bad_port', $p . '.schema', 'only data ports may declare a schema');
                        } else {
                            self::checkSchemaSubset($port['schema'], $p . '.schema', 'bad_port_schema', 1, $issues);
                        }
                    }
                }
            }
        }

        if (array_key_exists('configurationSchema', $value)) {
            $config = $value['configurationSchema'];
            if (!self::isMap($config) || ($config['type'] ?? null) !== 'object') {
                $issues[] = self::issue('bad_config_schema', $basePath . '.configurationSchema', 'configurationSchema must declare type "object"');
            } else {
                self::checkSchemaSubset($config, $basePath . '.configurationSchema', 'bad_config_schema', 1, $issues);
            }
        }

        // uiHints are presentation-only: invalid entries are IGNORED (dropped by consumers),
        // never fatal — the one deliberately ignorable surface (ADR-010).

        $handler = $value['handler'] ?? null;
        $kind = self::isMap($handler) ? ($handler['kind'] ?? null) : null;
        if (!self::isMap($handler) || !self::isStr($kind)) {
            $issues[] = self::issue('bad_handler', $basePath . '.handler', 'handler with a kind is required');
        } elseif ($kind === 'core-preset') {
            self::checkUnknownKeys($handler, ['kind', 'coreType', 'defaults'], $basePath . '.handler', $issues);
            if (!self::isStr($handler['coreType'] ?? null) || preg_match(self::CORE_TYPE, (string) $handler['coreType']) !== 1) {
                $issues[] = self::issue('bad_handler', $basePath . '.handler.coreType', 'coreType must be a dot-free core node type');
            }
            if (array_key_exists('defaults', $handler)) {
                if (!self::isMap($handler['defaults'])) {
                    $issues[] = self::issue('bad_handler', $basePath . '.handler.defaults', 'defaults must be an object');
                } elseif (strlen((string) json_encode($handler['defaults'])) > self::MAX_HANDLER_DEFAULTS_BYTES) {
                    $issues[] = self::issue('too_large', $basePath . '.handler.defaults', 'defaults exceed the size cap');
                }
            }
        } elseif ($kind === 'service-action') {
            self::checkUnknownKeys($handler, ['kind', 'bindingSlot', 'requiredAction'], $basePath . '.handler', $issues);
            $slot = $handler['bindingSlot'] ?? null;
            if (!self::isStr($slot) || preg_match(self::SLOT, (string) $slot) !== 1) {
                $issues[] = self::issue('bad_handler', $basePath . '.handler.bindingSlot', 'bindingSlot must match the slot grammar');
            } elseif ($declaredSlots !== null && !in_array($slot, $declaredSlots, true)) {
                $issues[] = self::issue('unknown_binding_slot', $basePath . '.handler.bindingSlot', 'bindingSlot "' . $slot . '" is not declared in requirements.services');
            }
            if (!self::isStr($handler['requiredAction'] ?? null) || preg_match(self::ACTION_ID, (string) $handler['requiredAction']) !== 1) {
                $issues[] = self::issue('bad_handler', $basePath . '.handler.requiredAction', 'requiredAction must match the action-id grammar');
            }
        } elseif (in_array($kind, self::LATER_HANDLER_KINDS, true)) {
            $issues[] = self::issue('handler_kind_not_enabled', $basePath . '.handler.kind', 'handler kind "' . $kind . '" requires a newer FormLogic host feature');
        } else {
            $issues[] = self::issue('bad_handler', $basePath . '.handler.kind', 'unknown handler kind "' . $kind . '"');
        }

        if (array_key_exists('availability', $value) && !self::isEnumList($value['availability'], self::HOSTS, 3, true)) {
            $issues[] = self::issue('bad_availability', $basePath . '.availability', 'availability must be a unique subset of desktop | paired-browser | cloud');
        }
        if (array_key_exists('requiredGrants', $value)) {
            $grants = $value['requiredGrants'];
            $ok = self::isList($grants) && count($grants) <= 32;
            if ($ok) {
                foreach ($grants as $g) {
                    if (!self::isStr($g, 1, 128)) {
                        $ok = false;
                        break;
                    }
                }
            }
            if (!$ok) {
                $issues[] = self::issue('bad_grants', $basePath . '.requiredGrants', 'requiredGrants must be at most 32 non-empty strings');
            }
        }
        if (!self::isStr($value['sideEffects'] ?? null) || !in_array($value['sideEffects'], self::SIDE_EFFECTS, true)) {
            $issues[] = self::issue('bad_side_effects', $basePath . '.sideEffects', 'sideEffects must be none | read | external-write | destructive');
        }
        if (array_key_exists('idempotency', $value) && !in_array($value['idempotency'], self::IDEMPOTENCY, true)) {
            $issues[] = self::issue('bad_idempotency', $basePath . '.idempotency', 'idempotency must be none | caller-key');
        }
        if (array_key_exists('deprecation', $value) && $value['deprecation'] !== null) {
            $dep = $value['deprecation'];
            if (!self::isMap($dep)) {
                $issues[] = self::issue('bad_deprecation', $basePath . '.deprecation', 'deprecation must be null or an object');
            } else {
                self::checkUnknownKeys($dep, ['message', 'replacedBy'], $basePath . '.deprecation', $issues);
                if (array_key_exists('message', $dep) && !self::isStr($dep['message'], 0, 300)) {
                    $issues[] = self::issue('bad_deprecation', $basePath . '.deprecation.message', 'message must be a string of at most 300 chars');
                }
                if (array_key_exists('replacedBy', $dep) && !self::isStr($dep['replacedBy'], 0, 160)) {
                    $issues[] = self::issue('bad_deprecation', $basePath . '.deprecation.replacedBy', 'replacedBy must be a string of at most 160 chars');
                }
            }
        }

        return array_values($issues);
    }

    /**
     * Declaration-subset schema walk (strictly tighter than the §6.5 runtime validator).
     *
     * @param list<array{code:string,path:string,message:string}> $issues
     */
    private static function checkSchemaSubset(mixed $schema, string $path, string $baseCode, int $depth, array &$issues): void
    {
        if ($depth > self::MAX_SCHEMA_DEPTH) {
            $issues[] = self::issue('schema_too_deep', $path, 'schema nesting exceeds the depth cap (' . self::MAX_SCHEMA_DEPTH . ')');
            return;
        }
        if (!self::isMap($schema)) {
            $issues[] = self::issue($baseCode, $path, 'schema must be an object');
            return;
        }
        foreach ($schema as $key => $val) {
            $key = (string) $key;
            if (!in_array($key, self::SCHEMA_KEYWORDS, true)) {
                $issues[] = self::issue($baseCode, $path . '.' . $key, 'keyword "' . $key . '" is outside the declaration subset');
                continue;
            }
            switch ($key) {
                case '$ref':
                    if (!self::isStr($val)) {
                        $issues[] = self::issue($baseCode, $path . '.$ref', '$ref must be a string');
                    } elseif (!str_starts_with((string) $val, 'formlogic://')) {
                        $issues[] = self::issue('remote_ref', $path . '.$ref', 'only local formlogic:// schema references are allowed');
                    } elseif (!in_array($val, self::REF_ALLOWLIST, true)) {
                        $issues[] = self::issue('ref_not_allowlisted', $path . '.$ref', '"' . $val . '" is not on the schema $ref allowlist');
                    }
                    break;
                case 'type':
                    $types = self::isList($val) ? $val : [$val];
                    foreach ($types as $t) {
                        if (!self::isStr($t) || !in_array($t, self::SCHEMA_TYPES, true)) {
                            $issues[] = self::issue($baseCode, $path . '.type', 'type must name a supported JSON type');
                            break;
                        }
                    }
                    break;
                case 'properties':
                    if (!self::isMap($val)) {
                        $issues[] = self::issue($baseCode, $path . '.properties', 'properties must be an object');
                    } else {
                        if (count($val) > self::MAX_SCHEMA_PROPERTIES) {
                            $issues[] = self::issue($baseCode, $path . '.properties', 'more than ' . self::MAX_SCHEMA_PROPERTIES . ' properties');
                        }
                        foreach ($val as $name => $sub) {
                            self::checkSchemaSubset($sub, $path . '.properties.' . (string) $name, $baseCode, $depth + 1, $issues);
                        }
                    }
                    break;
                case 'items':
                    self::checkSchemaSubset($val, $path . '.items', $baseCode, $depth + 1, $issues);
                    break;
                case 'additionalProperties':
                    if (!is_bool($val)) {
                        self::checkSchemaSubset($val, $path . '.additionalProperties', $baseCode, $depth + 1, $issues);
                    }
                    break;
                case 'required':
                    $ok = self::isList($val);
                    if ($ok) {
                        foreach ($val as $r) {
                            if (!self::isStr($r)) {
                                $ok = false;
                                break;
                            }
                        }
                    }
                    if (!$ok) {
                        $issues[] = self::issue($baseCode, $path . '.required', 'required must be an array of strings');
                    }
                    break;
                case 'enum':
                    if (!self::isList($val) || count($val) === 0 || count($val) > self::MAX_ENUM_ENTRIES) {
                        $issues[] = self::issue($baseCode, $path . '.enum', 'enum must be a non-empty array of at most ' . self::MAX_ENUM_ENTRIES . ' entries');
                    }
                    break;
                case 'minLength':
                case 'maxLength':
                    if (!is_int($val) || $val < 0) {
                        $issues[] = self::issue($baseCode, $path . '.' . $key, $key . ' must be a non-negative integer');
                    }
                    break;
                case 'minimum':
                case 'maximum':
                    if (!is_int($val) && !is_float($val)) {
                        $issues[] = self::issue($baseCode, $path . '.' . $key, $key . ' must be a finite number');
                    }
                    break;
                case 'x-artifactKinds':
                    if (!self::isEnumList($val, self::ARTIFACT_KINDS, 8, false)) {
                        $issues[] = self::issue($baseCode, $path . '.x-artifactKinds', 'x-artifactKinds must list supported artifact kinds');
                    }
                    break;
                default:
                    break; // title/description/default/examples/const — annotation or free-form.
            }
        }
    }

    /** @return array{code:string,path:string,message:string} */
    private static function issue(string $code, string $path, string $message): array
    {
        return ['code' => $code, 'path' => $path, 'message' => $message];
    }

    /** A JSON object after assoc decode: an array that is empty or NOT a list (see class doc). */
    private static function isMap(mixed $v): bool
    {
        return is_array($v) && ($v === [] || !array_is_list($v));
    }

    /** A JSON array after assoc decode: an array that is empty or a list. */
    private static function isList(mixed $v): bool
    {
        return is_array($v) && ($v === [] || array_is_list($v));
    }

    private static function isStr(mixed $v, int $min = 0, ?int $max = null): bool
    {
        return is_string($v) && strlen($v) >= $min && ($max === null || strlen($v) <= $max);
    }

    /** @param list<string> $allowed */
    private static function isEnumList(mixed $v, array $allowed, int $maxItems, bool $unique): bool
    {
        if (!self::isList($v) || count($v) > $maxItems) {
            return false;
        }
        foreach ($v as $item) {
            if (!is_string($item) || !in_array($item, $allowed, true)) {
                return false;
            }
        }
        if ($unique && count(array_unique($v)) !== count($v)) {
            return false;
        }
        return true;
    }

    /**
     * Fail closed on unknown keys (ADR ground rule).
     *
     * @param array<string,mixed> $value
     * @param list<string> $allowed
     * @param list<array{code:string,path:string,message:string}> $issues
     */
    private static function checkUnknownKeys(array $value, array $allowed, string $path, array &$issues): void
    {
        foreach (array_keys($value) as $key) {
            if (!in_array((string) $key, $allowed, true)) {
                $issues[] = self::issue('unknown_field', $path . '.' . (string) $key, 'unknown field "' . (string) $key . '" (unknown fields fail closed)');
            }
        }
    }
}
