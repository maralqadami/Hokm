<?php
declare(strict_types=1);

final class Db
{
    public readonly PDO $pdo;

    public function __construct(string $dir, bool $create = false)
    {
        $file = $dir . '/hokm.sqlite3';
        if (!$create && !is_file($file)) {
            throw new RuntimeException('پایگاه داده پیدا نشد.');
        }
        $old = umask(0077);
        try {
            $this->pdo = new PDO('sqlite:' . $file, null, null, [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_STRINGIFY_FETCHES => false,
            ]);
        } finally {
            umask($old);
        }
        $this->pdo->exec('PRAGMA busy_timeout=3500');
        $this->pdo->exec('PRAGMA foreign_keys=ON');
        if ($create) {
            chmod($file, 0600);
            $this->pdo->exec('PRAGMA journal_mode=WAL');
            $this->write(fn() => $this->pdo->exec(file_get_contents(__DIR__ . '/schema.sql')));
        }
    }

    private function statement(string $sql, array $parameters): PDOStatement
    {
        $stmt = $this->pdo->prepare($sql);
        foreach (array_values($parameters) as $i => $value) {
            $type = match (true) {
                $value === null => PDO::PARAM_NULL,
                is_int($value) => PDO::PARAM_INT,
                default => PDO::PARAM_STR,
            };
            $stmt->bindValue($i + 1, $value, $type);
        }
        $stmt->execute();
        return $stmt;
    }

    public function run(string $sql, mixed ...$parameters): int
    {
        return $this->statement($sql, $parameters)->rowCount();
    }

    public function one(string $sql, mixed ...$parameters): ?array
    {
        return $this->statement($sql, $parameters)->fetch() ?: null;
    }

    public function all(string $sql, mixed ...$parameters): array
    {
        return $this->statement($sql, $parameters)->fetchAll();
    }

    public function value(string $sql, mixed ...$parameters): mixed
    {
        $value = $this->statement($sql, $parameters)->fetchColumn();
        return $value === false ? null : $value;
    }

    public function write(callable $action): mixed
    {
        $this->pdo->exec('BEGIN IMMEDIATE');
        try {
            $result = $action();
            $this->pdo->exec('COMMIT');
            return $result;
        } catch (Throwable $error) {
            $this->pdo->exec('ROLLBACK');
            throw $error;
        }
    }

    public function flag(string $key): bool
    {
        return $this->value('SELECT value FROM settings WHERE key=?', $key) === '1';
    }
}
