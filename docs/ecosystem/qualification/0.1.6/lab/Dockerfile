# FormLogic qualification host: Apache + PHP 8.3 with the extensions INSTALL.txt
# requires, plus Node 24 for native app hosting. Nothing FormLogic-specific is
# baked in; the extracted release zip is mounted at /var/www/html.
FROM php:8.3-apache
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      libzip-dev libpng-dev libjpeg62-turbo-dev libfreetype6-dev libsqlite3-dev unzip curl ca-certificates xz-utils procps default-mysql-client \
    && docker-php-ext-configure gd --with-freetype --with-jpeg \
    && docker-php-ext-install -j"$(nproc)" pdo_mysql zip gd \
    && a2enmod rewrite headers \
    && sed -i 's#AllowOverride None#AllowOverride All#g' /etc/apache2/apache2.conf \
    && rm -rf /var/lib/apt/lists/*
# Node 24 (the native runtime's minimum is 24.19).
RUN curl -fsSL https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz -o /tmp/node.tar.xz \
    && mkdir -p /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1 && rm /tmp/node.tar.xz \
    && ln -s /opt/node/bin/node /usr/local/bin/node
RUN printf 'upload_max_filesize=200M\npost_max_size=220M\nmemory_limit=512M\nmax_execution_time=120\n' > /usr/local/etc/php/conf.d/formlogic.ini
