import os
import secrets
from dotenv import load_dotenv

load_dotenv()

class Config:
    # Provide a default SQLite database if DATABASE_URL is not set
    SQLALCHEMY_DATABASE_URI = os.getenv('DATABASE_URL', 'sqlite:///local.db')
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SQLALCHEMY_ENGINE_OPTIONS = {
        "pool_pre_ping": True,
        "pool_recycle": 300,
        "pool_size": 20,
        "max_overflow": 10
    }
    CACHE_TYPE = 'SimpleCache'
    CACHE_DEFAULT_TIMEOUT = 300
    SECRET_KEY = os.getenv('SECRET_KEY', secrets.token_hex(32))

class ProductionConfig(Config):
    DEBUG = False
    FLASK_ENV = 'production'

# Use production config by default
config = ProductionConfig
