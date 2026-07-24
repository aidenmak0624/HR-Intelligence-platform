#!/usr/bin/env python3
"""
Build-time RAG index baker.

Run during `docker build` (and locally after changing policy documents) to:
1. Download the sentence-transformer embedding model into the HF cache.
2. Ingest all policy documents and the employee handbook into ChromaDB
   at ./chromadb_hr, so containers start with a ready, warm index instead
   of downloading models and ingesting at cold start.

Usage:
    python scripts/build_rag_index.py
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def main() -> int:
    from src.core.rag_pipeline import RAGPipeline

    pipeline = RAGPipeline()

    if not pipeline.use_chromadb or pipeline.embedding_model is None:
        print("ERROR: ChromaDB or embedding model unavailable — cannot bake index")
        return 1

    total = 0
    for path in sorted((ROOT / "data" / "policies").glob("*.txt")):
        count = pipeline.ingest_document(str(path), doc_type="policy")
        print(f"  {path.name}: {count} chunks")
        total += count

    handbook_dir = ROOT / "data" / "knowledge_base" / "employee_handbook"
    if handbook_dir.exists():
        for path in sorted(handbook_dir.glob("*.txt")):
            count = pipeline.ingest_document(str(path), doc_type="handbook")
            print(f"  {path.name}: {count} chunks")
            total += count

    if total == 0:
        print("ERROR: 0 chunks ingested — index is empty")
        return 1

    print(f"RAG index baked: {total} chunks at {ROOT / 'chromadb_hr'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
