#!/usr/bin/env python3
"""
Extract JSON schemas from DANDI Pydantic models for use with LLM constraints.
"""

import json
import os
from pathlib import Path
from typing import Dict, Any

try:
    from dandischema.models import (
        Dandiset,
        Asset,
        BareAsset,
        Person,
        Organization,
        AssetsSummary,
        AccessRequirements,
        Contributor,
        ContactPoint,
        Affiliation,
        PropertyValue,
        Resource,
        Activity,
        Project,
        Session,
        Equipment,
        Software,
        Agent
    )
    print("Successfully imported DANDI schema models")
except ImportError as e:
    print(f"Error importing DANDI schema: {e}")
    print("Please install dandischema: pip install dandischema")
    exit(1)


def simplify_schema_for_llm(schema: Dict[str, Any]) -> Dict[str, Any]:
    """
    Simplify complex schemas for better LLM compatibility.
    Remove overly complex patterns and constraints that might confuse the LLM.
    """
    if isinstance(schema, dict):
        # Remove complex patterns that might be too restrictive
        if 'pattern' in schema and len(schema.get('pattern', '')) > 50:
            del schema['pattern']
        
        # Simplify overly complex anyOf/oneOf structures
        if 'anyOf' in schema and len(schema['anyOf']) > 5:
            # Keep only the most common types
            schema['anyOf'] = schema['anyOf'][:3]
        
        # Recursively process nested objects
        for key, value in schema.items():
            if isinstance(value, dict):
                schema[key] = simplify_schema_for_llm(value)
            elif isinstance(value, list):
                schema[key] = [simplify_schema_for_llm(item) if isinstance(item, dict) else item for item in value]
    
    return schema


def extract_schemas():
    """Extract JSON schemas from DANDI Pydantic models"""
    
    # Key models to extract for LLM enhancement
    models = {
        'Dandiset': Dandiset,
        'Person': Person,
        'Organization': Organization,
        'Contributor': Contributor,
        'ContactPoint': ContactPoint,
        'Affiliation': Affiliation,
        'AssetsSummary': AssetsSummary,
        'AccessRequirements': AccessRequirements,
        'PropertyValue': PropertyValue,
        'Resource': Resource,
        'Activity': Activity,
        'Project': Project,
        'Session': Session,
        'Equipment': Equipment,
        'Software': Software,
        'Agent': Agent,
        'Asset': Asset,
        'BareAsset': BareAsset,
    }
    
    # Create schemas directory
    schemas_dir = Path(__file__).parent.parent / 'src' / 'schemas'
    schemas_dir.mkdir(parents=True, exist_ok=True)
    
    extracted_schemas = {}
    
    for name, model in models.items():
        try:
            # Extract JSON schema
            schema = model.model_json_schema()
            
            # Simplify for LLM use
            simplified_schema = simplify_schema_for_llm(schema)
            
            # Save individual schema file
            schema_file = schemas_dir / f'{name.lower()}.schema.json'
            with open(schema_file, 'w') as f:
                json.dump(simplified_schema, f, indent=2)
            
            extracted_schemas[name] = simplified_schema
            print(f"✓ Extracted schema for {name}")
            
        except Exception as e:
            print(f"✗ Error extracting schema for {name}: {e}")
            continue
    
    # Create a combined schema file for easy reference
    combined_file = schemas_dir / 'all_schemas.json'
    with open(combined_file, 'w') as f:
        json.dump(extracted_schemas, f, indent=2)
    
    print(f"\n✓ Extracted {len(extracted_schemas)} schemas to {schemas_dir}")
    print(f"✓ Combined schemas saved to {combined_file}")
    
    # Create a summary file with schema information
    summary = {
        'extracted_at': __import__('datetime').datetime.now().isoformat(),
        'total_schemas': len(extracted_schemas),
        'schema_names': list(extracted_schemas.keys()),
        'file_locations': {
            name: f'{name.lower()}.schema.json' 
            for name in extracted_schemas.keys()
        }
    }
    
    summary_file = schemas_dir / 'schema_summary.json'
    with open(summary_file, 'w') as f:
        json.dump(summary, f, indent=2)
    
    return extracted_schemas


if __name__ == "__main__":
    print("Extracting DANDI schemas for LLM use...")
    schemas = extract_schemas()
    print("\nSchema extraction complete!")
