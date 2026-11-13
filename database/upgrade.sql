-- BitByte PC Parts upgrade migration (MySQL 8 / MariaDB)
-- Select the existing application database before running this script.
-- The application also applies these additions automatically on startup.

DELIMITER $$
CREATE PROCEDURE bitbyte_add_stock_threshold_if_missing()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'products'
      AND COLUMN_NAME = 'low_stock_threshold'
  ) THEN
    ALTER TABLE products ADD COLUMN low_stock_threshold INT NOT NULL DEFAULT 5;
  END IF;
END$$
DELIMITER ;
CALL bitbyte_add_stock_threshold_if_missing();
DROP PROCEDURE bitbyte_add_stock_threshold_if_missing;

CREATE TABLE IF NOT EXISTS users (
  user_id INT AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(120) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('Admin','Manager','Cashier','Inventory Staff') NOT NULL DEFAULT 'Cashier',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS stock_movements (
  movement_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  user_id INT NULL,
  movement_type VARCHAR(40) NOT NULL,
  quantity_change INT NOT NULL,
  note VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_stock_product_date(product_id, created_at),
  CONSTRAINT fk_stock_product FOREIGN KEY(product_id) REFERENCES products(product_id),
  CONSTRAINT fk_stock_user FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;
