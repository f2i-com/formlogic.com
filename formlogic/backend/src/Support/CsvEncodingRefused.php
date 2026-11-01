<?php

declare(strict_types=1);

namespace FormLogic\Support;

/** A CSV in an encoding that can't be told from its bytes: reading it would store the wrong letters. */
final class CsvEncodingRefused extends \RuntimeException
{
    public function __construct()
    {
        parent::__construct('This file isn\'t in UTF-8, and its text doesn\'t look like Western European, so it can\'t be read safely. Nothing was imported. In Excel, choose Save As and pick "CSV UTF-8 (Comma delimited)", then upload that file.');
    }
}
